// `tramecli deployments ships`: the per-repo rules matching waiting releases to cards.
use super::{ID, sanitize, settings_view, watched};
use crate::plugins::api::{CliCommand, CliReply, settings};
use serde_json::{Value, json};
use std::path::Path;

pub const COMMANDS: &[CliCommand] = &[CliCommand {
    name: "ships",
    usage: "[<repo> [--env a,b] [--pattern '<regex>'] [--backport|--no-backport] [--reset]]",
    summary: "list or change the rule matching a repo's waiting releases to cards",
}];

/// `ships` with the given flags applied to `repo`'s rule; only the flags given change.
pub fn apply_flags(ships: &Value, repo: &str, args: &[String]) -> Result<Value, String> {
    let mut out = ships.as_object().cloned().unwrap_or_default();
    if args.iter().any(|a| a == "--reset") {
        out.remove(repo);
        return Ok(Value::Object(out));
    }
    let mut rule = out.get(repo).cloned().unwrap_or_else(|| json!({}));
    for (flag, key) in [("--pattern", "pattern"), ("--env", "environments")] {
        if let Some(index) = args.iter().position(|a| a == flag) {
            let Some(value) = args.get(index + 1) else {
                return Err(format!("{flag} needs a value"));
            };
            rule[key] = if flag == "--env" {
                json!(
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                )
            } else {
                json!(value)
            };
        }
    }
    if args.iter().any(|a| a == "--backport") {
        rule["backport"] = json!(true);
    }
    if args.iter().any(|a| a == "--no-backport") {
        rule["backport"] = json!(false);
    }
    out.insert(repo.into(), rule);
    Ok(Value::Object(out))
}

pub fn ships(settings_path: &Path, args: &[String]) -> CliReply {
    let slice = settings::plugin(settings_path, ID);
    let mut view = settings_view(&slice);
    let repo = args.first();
    let flags = args.get(1..).unwrap_or(&[]);
    let mut lines = Vec::new();
    if let Some(repo) = repo.filter(|_| !flags.is_empty()) {
        if !watched(&slice).contains(repo) {
            return CliReply::fail(format!(
                "{repo} is not a watched repo — add it in the Deployments settings first"
            ));
        }
        let ships = match apply_flags(&view["ships"], repo, flags) {
            Ok(ships) => ships,
            Err(e) => return CliReply::fail(e),
        };
        let patch = sanitize(&json!({"ships":ships}), &slice);
        if let Err(e) = settings::save_plugin(settings_path, ID, &patch) {
            return CliReply::fail(e.to_string());
        }
        view = settings_view(&settings::plugin(settings_path, ID));
        if let Some(index) = flags.iter().position(|a| a == "--pattern") {
            if view["ships"][repo]["pattern"].as_str() != flags.get(index + 1).map(|s| s.trim()) {
                lines.push(
                    "pattern dropped: it must compile and have exactly one capture group, e.g. 'PR-(\\d+)'"
                        .to_owned(),
                );
            }
        }
    }
    for (key, forge) in [("githubRepos", "github"), ("gitlabProjects", "gitlab")] {
        for name in view[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|name| repo.is_none_or(|r| r == name))
        {
            let custom = &view["ships"][name];
            let defaults = &view["shipDefaults"][forge];
            let pattern = custom["pattern"]
                .as_str()
                .or_else(|| defaults["pattern"].as_str())
                .unwrap_or("");
            let env = custom["environments"]
                .as_array()
                .filter(|a| !a.is_empty())
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_else(|| "all".into());
            let backport = custom["backport"]
                .as_bool()
                .or_else(|| defaults["backport"].as_bool())
                .unwrap_or(false);
            let mark = if custom.as_object().is_some_and(|o| !o.is_empty()) {
                "  (custom)"
            } else {
                ""
            };
            lines.push(format!(
                "{name} [{forge}]  pattern {pattern} · env {env} · backport {}{mark}",
                if backport { "on" } else { "off" }
            ));
        }
    }
    CliReply::ok(
        lines.join("\n"),
        json!({"ships":view["ships"],"shipDefaults":view["shipDefaults"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::apply_flags;
    use serde_json::json;

    #[test]
    fn flags_change_only_what_they_name() {
        let ships = json!({"a/x":{"pattern":"old","backport":false},"b/y":{"pattern":"keep"}});
        let args = [
            "--pattern",
            "PR-(\\d+)",
            "--env",
            "prod, stage",
            "--backport",
        ]
        .map(str::to_owned);
        let updated = apply_flags(&ships, "a/x", &args).unwrap();
        assert_eq!(
            updated["a/x"],
            json!({"pattern":"PR-(\\d+)","environments":["prod","stage"],"backport":true})
        );
        assert_eq!(updated["b/y"], ships["b/y"]);
        let env_only = apply_flags(
            &ships,
            "a/x",
            &["--env".into(), "production, staging".into()],
        )
        .unwrap();
        assert_eq!(
            env_only["a/x"],
            json!({"pattern":"old","backport":false,"environments":["production","staging"]})
        );
        assert!(
            apply_flags(&ships, "a/x", &["--env".into()])
                .unwrap_err()
                .contains("--env needs a value")
        );
        assert!(
            apply_flags(&ships, "a/x", &["--reset".into()])
                .unwrap()
                .get("a/x")
                .is_none()
        );
    }
}
