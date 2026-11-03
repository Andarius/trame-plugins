// Project and group avatars from the forges, kept in memory and served same-origin (the desktop
// CSP blocks remote images). Keys are "project:<path>" and "group:<top-level namespace>".
use super::{
    auth::{self, Auth},
    encode, github, gitlab,
};
use crate::plugins::api::blocking;
use axum::{body::Bytes, response::IntoResponse, response::Response};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_hours(24);
const MAX_BYTES: u64 = 512 * 1024;
// raster only: an SVG served from this origin could run script when opened directly
const TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

struct Logo {
    fetched: Instant,
    image: Option<(Bytes, String)>,
}

static LOGOS: LazyLock<Mutex<HashMap<String, Logo>>> = LazyLock::new(Mutex::default);

fn lock() -> MutexGuard<'static, HashMap<String, Logo>> {
    LOGOS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The top-level namespace of a repo path: the org or group its tab is named after.
pub fn group_of(repo: &str) -> &str {
    repo.split('/').next().unwrap_or(repo)
}

fn stale(key: &str) -> bool {
    lock().get(key).is_none_or(|l| l.fetched.elapsed() > TTL)
}

fn store(key: String, image: Option<(Bytes, String)>) {
    lock().insert(
        key,
        Logo {
            fetched: Instant::now(),
            image,
        },
    );
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Option<(Bytes, String)> {
    let mut req = client.get(url);
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        req = req.header("private-token", token);
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let kind = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })?;
    if !TYPES.contains(&kind.as_str()) || res.content_length().is_some_and(|n| n > MAX_BYTES) {
        return None;
    }
    let body = res.bytes().await.ok()?;
    (body.len() as u64 <= MAX_BYTES).then_some((body, kind))
}

/// The image type of `bytes` from its magic number, for bodies that come without a header.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

/// GitLab: the avatar endpoint (through glab when that is the login, else with the token), then
/// the `avatar_url` itself, which a private project or group only serves to a logged-in user.
async fn gitlab_logo(
    client: &reqwest::Client,
    base: &str,
    auth: &Auth,
    kind: &str,
    path: &str,
) -> Option<(Bytes, String)> {
    let api = if kind == "project" {
        "projects"
    } else {
        "groups"
    };
    let endpoint = format!("{api}/{}/avatar", encode(path));
    if auth.source == "cli" {
        let host = auth::hostname(base).ok()?;
        let bytes = blocking(move || auth::glab_bytes(&host, &endpoint))
            .await
            .ok()
            .flatten()?;
        let kind = sniff(&bytes)?;
        return (bytes.len() as u64 <= MAX_BYTES).then(|| (Bytes::from(bytes), kind.to_owned()));
    }
    if !auth.token.is_empty() {
        let url = format!("{base}/api/v4/{endpoint}");
        if let Some(image) = download(client, &url, Some(&auth.token)).await {
            return Some(image);
        }
    }
    let info = gitlab::get(client, base, auth, &format!("{api}/{}", encode(path)))
        .await
        .ok()?;
    let raw = info["avatar_url"]
        .as_str()
        .or_else(|| info["namespace"]["avatar_url"].as_str())?;
    let base_url = reqwest::Url::parse(base).ok()?;
    let url = base_url.join(raw).ok()?;
    let same_host = url.host_str() == base_url.host_str();
    download(
        client,
        url.as_str(),
        same_host.then_some(auth.token.as_str()),
    )
    .await
}

/// GitHub repos have no logo of their own: a repo and its org both show the owner's avatar.
async fn github_logo(
    client: &reqwest::Client,
    token: &str,
    owner: &str,
) -> Option<(Bytes, String)> {
    let info = github::gh(client, &format!("/users/{owner}"), token)
        .await
        .ok()?;
    download(client, info["avatar_url"].as_str()?, None).await
}

/// Fetches the logos missing or older than a day; a failure is cached too, so it retries daily.
pub async fn sync(
    client: &reqwest::Client,
    repos: &[String],
    projects: &[String],
    base: &str,
    gh: &Auth,
    gl: &Auth,
) {
    if !gh.token.is_empty() {
        for owner in repos
            .iter()
            .map(|r| group_of(r))
            .collect::<std::collections::BTreeSet<_>>()
        {
            if !stale(&format!("group:{owner}")) {
                continue;
            }
            let image = github_logo(client, &gh.token, owner).await;
            for repo in repos.iter().filter(|r| group_of(r) == owner) {
                store(format!("project:{repo}"), image.clone());
            }
            store(format!("group:{owner}"), image);
        }
    }
    if gl.source == "none" {
        return;
    }
    for project in projects {
        let key = format!("project:{project}");
        if stale(&key) {
            let image = gitlab_logo(client, base, gl, "project", project).await;
            store(key, image);
        }
    }
    for group in projects
        .iter()
        .map(|p| group_of(p))
        .collect::<std::collections::BTreeSet<_>>()
    {
        let key = format!("group:{group}");
        if stale(&key) {
            let image = gitlab_logo(client, base, gl, "group", group).await;
            store(key, image);
        }
    }
}

/// The keys that have an image, for the UI to request only what exists.
pub fn available() -> Value {
    json!(
        lock()
            .iter()
            .filter(|(_, l)| l.image.is_some())
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>()
    )
}

/// `GET /logo?key=…`: the cached image, or 404.
pub fn serve(query: &str) -> Option<Response> {
    let key = reqwest::Url::parse(&format!("http://localhost/?{query}"))
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == "key")?
        .1
        .into_owned();
    let (body, kind) = lock().get(&key)?.image.clone()?;
    Some(
        (
            [
                ("content-type", kind),
                ("cache-control", "private, max-age=3600".to_owned()),
                ("x-content-type-options", "nosniff".to_owned()),
            ],
            body,
        )
            .into_response(),
    )
}

#[cfg(test)]
pub fn insert(key: &str, image: Option<(Bytes, String)>) {
    store(key.to_owned(), image);
}
