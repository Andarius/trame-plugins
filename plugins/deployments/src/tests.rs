#![allow(unsafe_code, reason = "tests mutate env vars (set_var/remove_var)")]
use super::{sanitize, settings_view};
use serde_json::{Value, json};

#[test]
fn gitlab_auth_never_lends_ambient_token_to_unsaved_host() {
    unsafe {
        std::env::set_var("GITLAB_TOKEN", "fixture-env-secret");
    }
    let saved = super::auth::gitlab(&json!({}), "https://gitlab.com", true);
    assert_eq!(saved.source, "env");
    assert_eq!(saved.token, "fixture-env-secret");
    let unsaved = super::auth::gitlab(&json!({}), "http://attacker.example", false);
    assert_eq!(unsaved.source, "none");
    assert!(unsaved.token.is_empty());
    let supplied = super::auth::gitlab(
        &json!({"gitlabToken":"pat-123"}),
        "http://attacker.example",
        false,
    );
    assert_eq!(supplied.source, "settings");
    assert_eq!(supplied.token, "pat-123");
    unsafe {
        std::env::remove_var("GITLAB_TOKEN");
    }
}

#[test]
fn forge_actions_require_watched_targets_and_valid_ids() {
    let slice = json!({"githubRepos":["acme/webapp"],"gitlabProjects":["acme/api"]});
    for action in [
        json!({"kind":"github-approve","repo":"other/repo","runId":1,"environmentId":2}),
        json!({"kind":"gitlab-play","project":"other/project","jobId":1}),
    ] {
        assert!(super::live::action_precondition(&slice, &action).is_some());
    }
    assert_eq!(
        super::live::action_precondition(
            &slice,
            &json!({"kind":"github-reject","repo":"acme/webapp","runId":"bad","environmentId":2})
        )
        .unwrap()["error"],
        "bad action"
    );
    assert_eq!(
        super::live::action_precondition(&slice, &json!({"kind":"bogus"})).unwrap()["error"],
        "unknown action"
    );
    assert!(
        super::live::action_precondition(
            &slice,
            &json!({"kind":"github-approve","repo":"acme/webapp","runId":1,"environmentId":2})
        )
        .is_none()
    );
    assert!(
        super::live::action_precondition(
            &slice,
            &json!({"kind":"gitlab-reject","project":"acme/api","deploymentId":3})
        )
        .is_none()
    );
}

#[test]
fn ships_rules_refs_and_card_matching_retain_source_cases() {
    let gh = super::ships::defaults("github");
    let gl = super::ships::defaults("gitlab");
    for (message, pattern, want) in [
        (
            "[master] fix(ci): retry (#3922) (#3923)",
            gh["pattern"].as_str().unwrap(),
            vec![3922, 3923],
        ),
        (
            "feat: checkout revamp (#120)",
            gh["pattern"].as_str().unwrap(),
            vec![120],
        ),
        (
            "Merge pull request #57 from acme/feat",
            gh["pattern"].as_str().unwrap(),
            vec![57],
        ),
        (
            "Merge branch 'chore/x' into 'master'\n\nchore: drop map\n\nSee merge request obitrain/obiapp!200",
            gl["pattern"].as_str().unwrap(),
            vec![200],
        ),
        ("PROJ-12: fix login (PR-88)", "PR-(\\d+)", vec![88]),
        ("chore: bump deps", gh["pattern"].as_str().unwrap(), vec![]),
    ] {
        assert_eq!(super::ships::ref_numbers(message, pattern), want);
    }
    let fixture: Value = serde_json::from_str(super::SAMPLE).unwrap();
    let commits = fixture["changelogs"]["https://github.com/acme/webapp/actions/runs/123456789"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            super::ships::ref_numbers(
                c["title"].as_str().unwrap(),
                gh["pattern"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let card =
        |id: &str, url: Option<&str>| json!({"id":id,"title":id,"status":"active","pr_url":url});
    for (forge, refs, c, backport, want) in [
        (
            "github",
            commits.clone(),
            card("a", Some("https://github.com/acme/webapp/pull/3928")),
            true,
            Some((3928, Some(3931))),
        ),
        (
            "github",
            commits.clone(),
            card("a", Some("https://github.com/acme/webapp/pull/3928")),
            false,
            Some((3928, None)),
        ),
        (
            "github",
            commits.clone(),
            card(
                "b",
                Some(
                    "https://github.com/acme/webapp/pull/1\nhttps://github.com/acme/webapp/pull/3931",
                ),
            ),
            true,
            Some((3931, Some(3928))),
        ),
        (
            "github",
            commits.clone(),
            card("c", Some("https://github.com/acme/api/pull/3928")),
            true,
            None,
        ),
        (
            "github",
            commits.clone(),
            card("d", Some("https://github.com/acme/webapp/pull/392")),
            true,
            None,
        ),
        (
            "gitlab",
            vec![vec![200]],
            card(
                "e",
                Some("https://gitlab.com/acme/webapp/-/merge_requests/200"),
            ),
            true,
            Some((200, None)),
        ),
        (
            "gitlab",
            vec![vec![200]],
            card(
                "f",
                Some("https://git.corp/acme/webapp/-/merge_requests/200"),
            ),
            true,
            None,
        ),
        ("github", commits, card("g", None), true, None),
    ] {
        let hit = super::ships::match_cards(
            forge,
            "https://gitlab.com",
            "acme/webapp",
            &refs,
            &[c],
            backport,
        );
        assert_eq!(
            hit.first()
                .map(|h| (h["pr"].as_i64().unwrap(), h["via"].as_i64())),
            want
        );
    }
    let stored = json!({"acme/webapp":{"pattern":"PR-(\\d+)","environments":["production"],"backport":false},"acme/api":{"pattern":"(unclosed"}});
    assert_eq!(
        super::ships::rule_for(&stored, "acme/webapp", "github"),
        stored["acme/webapp"]
    );
    assert_eq!(super::ships::rule_for(&stored, "acme/api", "gitlab"), gl);
    assert_eq!(super::ships::rule_for(&stored, "acme/other", "github"), gh);
    assert_eq!(
        super::ships::sanitize_rules(
            &json!({"acme/webapp":stored["acme/webapp"],"acme/api":stored["acme/api"],"evil/unwatched":{"backport":false},"acme/x":{"pattern":"no-group"}}),
            &["acme/webapp".into(), "acme/api".into(), "acme/x".into()]
        ),
        json!({"acme/webapp":stored["acme/webapp"]})
    );
}

#[tokio::test]
async fn gitlab_live_adapter_maps_latest_environment_and_compare() {
    use axum::{Json, Router, http::Uri};
    let router=Router::new().fallback(|uri:Uri|async move {
        let path=uri.path();let query=uri.query().unwrap_or("");
        let body=if path.ends_with("/pipelines"){json!([{"status":"running"}])}
        else if path.ends_with("/deployments") && query.contains("status=success"){json!([{"sha":"base123456789"}])}
        else if path.ends_with("/deployments") {json!([
            {"id":1,"ref":"main","sha":"head123456","created_at":"2026-07-01T00:00:00Z","status":"blocked","user":{"username":"writer"},"environment":{"id":7,"name":"production"},"deployable":{"id":10,"name":"deploy prod","status":"manual","web_url":"https://gl.invalid/job/10"}},
            {"id":2,"ref":"old","sha":"old123","created_at":"2026-06-01T00:00:00Z","status":"blocked","environment":{"id":7,"name":"production"}},
            {"id":3,"ref":"main","sha":"head123456","created_at":"2026-07-01T00:00:00Z","status":"running","environment":{"id":8,"name":"staging"},"deployable":{"id":11,"name":"deploy staging","status":"running"}},
            {"id":4,"ref":"main","sha":"head123456","created_at":"2020-01-01T00:00:00Z","updated_at":"2020-01-01T01:00:00Z","status":"failed","environment":{"id":9,"name":"old-failed"}},
            {"id":5,"ref":"main","sha":"head123456","created_at":"2026-07-01T00:00:00Z","status":"success","environment":{"id":10,"name":"success"}}
        ])}
        else if path.ends_with("/repository/compare"){json!({"commits":[{"id":"fullsha","short_id":"full","title":"Ship!","message":"Ship! !12","author_name":"Writer","created_at":"2026-07-01T00:00:00Z"}]})}
        else if path.ends_with("/merge_requests"){json!([{"iid":12}])}
        else{json!({"default_branch":"main"})};Json(body)
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    let auth = super::auth::Auth {
        token: "fixture-token".into(),
        source: "settings",
    };
    let items = super::gitlab::pending(&client, "acme/api", &base, &auth)
        .await
        .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["action"]["kind"], "gitlab-play");
    assert_eq!(items[1]["cancel"]["kind"], "gitlab-cancel");
    assert!(
        super::gitlab::active_pipeline(&client, "acme/api", &base, &auth)
            .await
            .unwrap()
    );
    let change = super::gitlab::changelog(
        &client,
        "acme/api",
        &base,
        &auth,
        "production",
        "head123456",
    )
    .await
    .unwrap();
    assert_eq!(change["baseline"], "base1234");
    assert_eq!(change["commits"][0]["title"], "Ship!");
    let refs = super::gitlab::shipped_mrs(
        &client,
        "acme/api",
        &base,
        &auth,
        "production",
        "head123456",
        "!(\\d+)\\b",
    )
    .await
    .unwrap();
    assert_eq!(refs, vec![vec![12]]);
    server.abort();
}

#[test]
fn settings_never_echo_tokens_and_a_new_gitlab_host_drops_its_token() {
    let current = sanitize(
        &json!({"gitlabBaseUrl":"https://gl.example.com","gitlabToken":"secret-glpat","githubRepos":["acme/webapp"]}),
        &json!({}),
    );
    let view = settings_view(&current);
    assert_eq!(view["gitlabHasToken"], true);
    assert!(!view.to_string().contains("secret-glpat"));
    let moved = sanitize(
        &json!({"gitlabBaseUrl":"https://attacker.example.com"}),
        &current,
    );
    assert_eq!(moved["gitlabToken"], "");
    let kept = sanitize(&json!({"githubRepos":["acme/webapp","acme/api"]}), &current);
    assert_eq!(kept["gitlabToken"], "secret-glpat");
    assert_eq!(
        sanitize(&json!({"evil":1,"pollIdleSeconds":"2"}), &json!({}))["pollIdleSeconds"],
        15
    );
    assert!(
        sanitize(&json!({"evil":1}), &json!({}))
            .get("evil")
            .is_none()
    );
}

#[test]
fn logo_route_serves_only_cached_images() {
    use axum::body::Bytes;
    super::logos::insert(
        "group:acme",
        Some((Bytes::from_static(b"png"), "image/png".into())),
    );
    super::logos::insert("group:none", None);
    let hit = super::logos::serve("key=group%3Aacme").unwrap();
    assert_eq!(hit.headers()["content-type"], "image/png");
    assert_eq!(hit.headers()["x-content-type-options"], "nosniff");
    assert!(super::logos::serve("key=group%3Anone").is_none());
    assert!(super::logos::serve("key=group%3Aother").is_none());
    let keys = super::logos::available();
    assert!(keys.as_array().unwrap().contains(&json!("group:acme")));
    assert!(!keys.as_array().unwrap().contains(&json!("group:none")));
}

#[test]
fn sniff_accepts_raster_images_only() {
    use super::logos::sniff;
    for (bytes, want) in [
        (&b"\x89PNG\r\n\x1a\n"[..], Some("image/png")),
        (&b"\xFF\xD8\xFF\xE0"[..], Some("image/jpeg")),
        (&b"GIF89a"[..], Some("image/gif")),
        (&b"RIFF\0\0\0\0WEBPVP8 "[..], Some("image/webp")),
        (&b"<svg xmlns"[..], None),
        (&b""[..], None),
    ] {
        assert_eq!(sniff(bytes), want);
    }
}
