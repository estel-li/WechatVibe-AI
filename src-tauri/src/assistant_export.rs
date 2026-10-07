use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn filename(value: &str, format: &str) -> Result<String, String> {
    if !matches!(format, "md" | "txt") || value.chars().count() > 512 {
        return Err("导出格式或文件名无效".into());
    }
    let suffix = format!(".{format}");
    let trimmed = value.trim();
    let stem = trimmed.strip_suffix(&suffix).unwrap_or(trimmed);
    let cleaned: String = stem
        .chars()
        .take(140)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches([' ', '.']);
    let cleaned = if cleaned.is_empty() {
        "知意AI导出"
    } else {
        cleaned
    };
    let first = cleaned.split('.').next().unwrap_or(cleaned).to_uppercase();
    let reserved = matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            first.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    Ok(format!(
        "{}{cleaned}{suffix}",
        if reserved { "_" } else { "" }
    ))
}

// Only the path returned by the native save dialog reaches this function.
// Prepare the whole file before replacing it, preserving an existing export
// when a write fails. Error messages never contain a chat title or local path.
pub fn save(path: &Path, content: &str, format: &str) -> Result<(), String> {
    if !matches!(format, "md" | "txt") || content.trim().is_empty() || content.len() > 1024 * 1024 {
        return Err("导出内容为空或超过大小限制".into());
    }
    if path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case(format))
        != Some(true)
    {
        return Err(format!("请选择 .{format} 文件"));
    }
    let parent = path.parent().ok_or("保存位置无效")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "无法创建导出文件")?
        .as_nanos();
    let temporary = parent.join(format!(
        ".wechatvibe-export-{}-{stamp}.tmp",
        std::process::id()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建导出文件，请检查保存位置与写入权限")?;
    let written = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("保存失败，请检查磁盘空间与文件权限".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_preserves_chinese_and_rejects_unsafe_formats() {
        assert_eq!(
            filename("项目复盘：行动/清单.md", "md").unwrap(),
            "项目复盘：行动_清单.md"
        );
        assert_eq!(filename("CON.txt", "txt").unwrap(), "_CON.txt");
        assert_eq!(filename("LPT².md", "md").unwrap(), "_LPT².md");
        assert_eq!(filename(" .. ", "txt").unwrap(), "知意AI导出.txt");
        assert!(filename("test.exe", "exe").is_err());
    }

    #[test]
    fn save_is_utf8_and_preserves_existing_file_when_input_is_rejected() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "wechatvibe-export-test-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("会话总结.md");
        save(&path, "# 总结\n你好🙂\n", "md").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 总结\n你好🙂\n");
        assert!(save(&path, "", "md").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 总结\n你好🙂\n");
        save(&path, "更新后的总结", "md").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "更新后的总结");
        assert!(save(&root.join("program.exe"), "text", "md").is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }
}
