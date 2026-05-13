use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::Mutex;

const OLLAMA_PORT: u16 = 11436;
const JARVIS_PORT: u16 = 8000;

/// Small, stable model pulled at startup so the app opens reliably on low-memory systems.
const STARTUP_MODEL: &str = "qwen3.5:2b";

/// Tiny fallback model if even the startup model can't be pulled.
const FALLBACK_MODEL: &str = "qwen3:0.6b";

/// Qwen3.5 model variants, ordered smallest to largest.
/// Each entry is (ollama_tag, approximate_download_size_gb, min_ram_gb).
const QWEN35_MODELS: &[(&str, f64, f64)] = &[
    ("qwen3.5:0.8b", 1.0, 4.0),
    ("qwen3.5:2b", 2.7, 6.0),
    ("qwen3.5:4b", 3.4, 8.0),
    ("qwen3.5:9b", 6.6, 12.0),
    ("qwen3.5:27b", 17.0, 24.0),
    ("qwen3.5:35b", 24.0, 32.0),
    ("qwen3.5:122b", 81.0, 96.0),
];

/// Get total system RAM in GB.
fn total_ram_gb() -> f64 {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Ok(bytes) = s.trim().parse::<u64>() {
                    return bytes as f64 / (1024.0 * 1024.0 * 1024.0);
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = std::fs::read_to_string("/proc/meminfo") {
            for line in contents.lines() {
                if line.starts_with("MemTotal:") {
                    if let Some(kb_str) = line.split_whitespace().nth(1) {
                        if let Ok(kb) = kb_str.parse::<u64>() {
                            return kb as f64 / (1024.0 * 1024.0);
                        }
                    }
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // wmic returns TotalVisibleMemorySize in KB
        if let Ok(output) = Command::new("wmic")
            .args(["OS", "get", "TotalVisibleMemorySize", "/value"])
            .output()
        {
            if let Ok(s) = String::from_utf8(output.stdout) {
                for line in s.lines() {
                    if let Some(val) = line.strip_prefix("TotalVisibleMemorySize=") {
                        if let Ok(kb) = val.trim().parse::<u64>() {
                            return kb as f64 / (1024.0 * 1024.0);
                        }
                    }
                }
            }
        }
    }
    8.0
}

/// Return the list of Qwen3.5 models that fit on this machine, smallest first.
fn models_that_fit() -> Vec<&'static str> {
    let ram = total_ram_gb();
    QWEN35_MODELS
        .iter()
        .filter(|(_, _, min_ram)| ram >= *min_ram)
        .map(|(tag, _, _)| *tag)
        .collect()
}

/// Pick the default model — prefers STARTUP_MODEL if it fits, otherwise
/// falls back to the third-largest model that fits on this machine.
fn preferred_model() -> &'static str {
    let fitting = models_that_fit();
    // Prefer STARTUP_MODEL when it fits (stable default on modest systems)
    if fitting.contains(&STARTUP_MODEL) {
        return STARTUP_MODEL;
    }
    match fitting.len() {
        0 => FALLBACK_MODEL,
        1 => fitting[0],
        2 => fitting[0],
        n => fitting[n - 3], // third-largest
    }
}

/// Get the user home directory, handling both Unix (HOME) and Windows (USERPROFILE).
fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// Resolve full path to a binary by checking common locations.
/// macOS .app bundles don't inherit the shell PATH, so we probe manually.
fn resolve_bin(name: &str) -> String {
    let home = home_dir();

    #[cfg(not(target_os = "windows"))]
    let candidates = vec![
        format!("/opt/homebrew/bin/{name}"),
        format!("{home}/.local/bin/{name}"),
        format!("{home}/.cargo/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
    ];

    #[cfg(target_os = "windows")]
    let candidates = {
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let programfiles = std::env::var("ProgramFiles").unwrap_or_default();
        let programfiles_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        vec![
            // Git for Windows — standard install paths
            format!("{programfiles}\\Git\\cmd\\{name}.exe"),
            format!("{programfiles_x86}\\Git\\cmd\\{name}.exe"),
            format!("{localappdata}\\Programs\\Git\\cmd\\{name}.exe"),
            // Scoop package manager
            format!("{home}\\scoop\\shims\\{name}.exe"),
            // Cargo, local bin
            format!("{home}\\.cargo\\bin\\{name}.exe"),
            format!("{home}\\.local\\bin\\{name}.exe"),
            // Generic program locations
            format!("{localappdata}\\Programs\\{name}\\{name}.exe"),
            format!("{programfiles}\\{name}\\{name}.exe"),
            // Ollama installs to LOCALAPPDATA on Windows
            format!("{localappdata}\\Programs\\Ollama\\{name}.exe"),
            // uv installs via pip/pipx
            format!("{home}\\AppData\\Roaming\\Python\\Scripts\\{name}.exe"),
        ]
    };

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }

    // Fallback: ask the OS to find it on PATH.
    // On Windows this uses `where.exe`, on Unix `which`.
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("where")
            .arg(format!("{name}.exe"))
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let p = first_line.trim();
                    if !p.is_empty() && std::path::Path::new(p).exists() {
                        return p.to_string();
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = std::process::Command::new("which").arg(name).output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let p = first_line.trim();
                    if !p.is_empty() && std::path::Path::new(p).exists() {
                        return p.to_string();
                    }
                }
            }
        }
    }

    name.to_string()
}

/// Find the OpenJarvis project root (contains pyproject.toml).
/// Checks OPENJARVIS_ROOT env var, walks up from the executable, then
/// probes common clone locations.
fn find_project_root() -> Option<std::path::PathBuf> {
    // 1. Explicit env var override
    if let Ok(root) = std::env::var("OPENJARVIS_ROOT") {
        let path = std::path::PathBuf::from(&root);
        if path.join("pyproject.toml").exists() {
            return Some(path);
        }
    }

    // 2. Walk up from the running executable (works in dev and .app bundle)
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..8 {
            if let Some(ref d) = dir {
                if d.join("pyproject.toml").exists() {
                    return Some(d.clone());
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
    }

    // 3. Fallback: well-known direct paths
    let home = home_dir();
    let direct = [
        format!("{home}/OpenJarvis"),
        format!("{home}/projects/hazy/OpenJarvis"),
        format!("{home}/projects/OpenJarvis"),
        format!("{home}/src/OpenJarvis"),
        format!("{home}/Documents/OpenJarvis"),
        format!("{home}/Desktop/OpenJarvis"),
        format!("{home}/Developer/OpenJarvis"),
        format!("{home}/dev/OpenJarvis"),
        format!("{home}/Code/OpenJarvis"),
        format!("{home}/code/OpenJarvis"),
        format!("{home}/repos/OpenJarvis"),
        format!("{home}/github/OpenJarvis"),
    ];
    for p in &direct {
        let path = std::path::PathBuf::from(p);
        if path.join("pyproject.toml").exists() {
            return Some(path);
        }
    }

    // 4. Shallow scan: look for OpenJarvis one level inside common parent dirs.
    //    This catches clones like ~/Documents/my-stuff/OpenJarvis without
    //    needing to enumerate every possible intermediate folder.
    let scan_parents = [
        format!("{home}/Documents"),
        format!("{home}/Desktop"),
        format!("{home}/Developer"),
        format!("{home}/projects"),
        format!("{home}/repos"),
        format!("{home}/src"),
        format!("{home}/Code"),
        format!("{home}/code"),
        format!("{home}/dev"),
        format!("{home}/github"),
    ];
    for parent in &scan_parents {
        let parent_path = std::path::PathBuf::from(parent);
        if let Ok(entries) = std::fs::read_dir(&parent_path) {
            for entry in entries.flatten() {
                let candidate = entry.path().join("OpenJarvis");
                if candidate.join("pyproject.toml").exists() {
                    return Some(candidate);
                }
                // Also check if the entry itself is OpenJarvis (case-insensitive match)
                if let Some(name) = entry.file_name().to_str() {
                    if name.eq_ignore_ascii_case("openjarvis")
                        && entry.path().join("pyproject.toml").exists()
                    {
                        return Some(entry.path());
                    }
                }
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// BackendManager — owns the Ollama + Jarvis server child processes
// ---------------------------------------------------------------------------

struct ChildHandle {
    child: tokio::process::Child,
}

impl ChildHandle {
    async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

#[derive(Default)]
struct BackendManager {
    ollama: Option<ChildHandle>,
    jarvis: Option<ChildHandle>,
}

impl BackendManager {
    async fn stop_all(&mut self) {
        if let Some(ref mut h) = self.jarvis {
            h.kill().await;
        }
        self.jarvis = None;
        if let Some(ref mut h) = self.ollama {
            h.kill().await;
        }
        self.ollama = None;
    }
}

type SharedBackend = Arc<Mutex<BackendManager>>;

// ---------------------------------------------------------------------------
// Setup status (reported to frontend)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
struct SetupStatus {
    phase: String,
    detail: String,
    ollama_ready: bool,
    server_ready: bool,
    model_ready: bool,
    error: Option<String>,
}

impl Default for SetupStatus {
    fn default() -> Self {
        Self {
            phase: "starting".into(),
            detail: "Initializing...".into(),
            ollama_ready: false,
            server_ready: false,
            model_ready: false,
            error: None,
        }
    }
}

type SharedStatus = Arc<Mutex<SetupStatus>>;

// ---------------------------------------------------------------------------
// Health-check helpers
// ---------------------------------------------------------------------------

async fn wait_for_url(url: &str, timeout: Duration) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

async fn ollama_has_model(model: &str) -> bool {
    let url = format!("http://127.0.0.1:{}/api/tags", OLLAMA_PORT);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    if let Ok(resp) = client.get(&url).send().await {
        if let Ok(body) = resp.json::<serde_json::Value>().await {
            if let Some(models) = body.get("models").and_then(|m| m.as_array()) {
                return models.iter().any(|m| {
                    m.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| {
                            n == model
                                || n.strip_suffix(":latest") == Some(model)
                                || model.strip_suffix(":latest") == Some(n)
                        })
                        .unwrap_or(false)
                });
            }
        }
    }
    false
}

async fn pull_model(model: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/api/pull", OLLAMA_PORT);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({"name": model, "stream": false}))
        .send()
        .await
        .map_err(|e| format!("Pull request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Pull returned status {}", resp.status()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Backend boot sequence (runs in background after app launch)
// ---------------------------------------------------------------------------

#[allow(unreachable_code, unused_variables)]
async fn boot_backend(backend: SharedBackend, status: SharedStatus) {
    let existing_ollama_url = format!("http://127.0.0.1:{}/api/tags", OLLAMA_PORT);
    let existing_server_url = format!("http://127.0.0.1:{}/health", JARVIS_PORT);

    for _ in 0..30 {
        if wait_for_url(&existing_ollama_url, Duration::from_secs(1)).await
            && wait_for_url(&existing_server_url, Duration::from_secs(1)).await
        {
            let mut s = status.lock().await;
            s.phase = "ready".into();
            s.detail = "Using existing local backend.".into();
            s.ollama_ready = true;
            s.server_ready = true;
            s.model_ready = true;
            s.error = None;
            return;
        }

        {
            let mut s = status.lock().await;
            s.phase = "server".into();
            s.detail = "Waiting for local backend...".into();
            s.ollama_ready = wait_for_url(&existing_ollama_url, Duration::from_millis(500)).await;
            s.server_ready = false;
            s.model_ready = s.ollama_ready;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    {
        let mut s = status.lock().await;
        s.error = Some(
            "Local backend is not reachable. Start OpenJarvis with the Windows starter script."
                .into(),
        );
        return;
    }

    // Phase 1: Start Ollama
    {
        let mut s = status.lock().await;
        s.phase = "ollama".into();
        s.detail = "Starting inference engine...".into();
    }

    // Try the bundled sidecar first, fall back to system ollama
    let ollama_child = {
        let ollama_bin = resolve_bin("ollama");
        let sidecar = tokio::process::Command::new(&ollama_bin)
            .arg("serve")
            .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        match sidecar {
            Ok(child) => Some(child),
            Err(_) => None,
        }
    };

    if let Some(child) = ollama_child {
        backend.lock().await.ollama = Some(ChildHandle { child });
    }

    let ollama_url = format!("http://127.0.0.1:{}/api/tags", OLLAMA_PORT);
    let ollama_ok = wait_for_url(&ollama_url, Duration::from_secs(30)).await;

    if !ollama_ok {
        let mut s = status.lock().await;
        s.error = Some("Could not start Ollama. Install it from https://ollama.com".into());
        return;
    }

    {
        let mut s = status.lock().await;
        s.ollama_ready = true;
        s.detail = "Inference engine ready.".into();
    }

    // Phase 2: Pull one small model (qwen3.5:2b) so the app can open fast.
    // Remaining models are pulled in the background after the server starts.
    {
        let mut s = status.lock().await;
        s.phase = "model".into();
        s.detail = format!("Checking for {}...", STARTUP_MODEL);
    }

    if !ollama_has_model(STARTUP_MODEL).await {
        {
            let mut s = status.lock().await;
            s.detail = format!("Downloading {}... (this may take a minute)", STARTUP_MODEL);
        }
        if let Err(e) = pull_model(STARTUP_MODEL).await {
            // If the startup model fails, try the tiny fallback
            eprintln!("Warning: failed to pull {}: {}", STARTUP_MODEL, e);
            if !ollama_has_model(FALLBACK_MODEL).await {
                let mut s = status.lock().await;
                s.detail = format!("Downloading {}...", FALLBACK_MODEL);
                drop(s);
                if let Err(e2) = pull_model(FALLBACK_MODEL).await {
                    let mut s = status.lock().await;
                    s.error = Some(format!("Failed to download model: {}", e2));
                    return;
                }
            }
        }
    }

    {
        let mut s = status.lock().await;
        s.model_ready = true;
        s.detail = "Model ready.".into();
    }

    // Phase 3: Start jarvis serve
    {
        let mut s = status.lock().await;
        s.phase = "server".into();
        s.detail = "Starting API server...".into();
    }

    let uv_bin = resolve_bin("uv");

    // Verify uv is actually installed
    if !std::path::Path::new(&uv_bin).exists() && uv_bin == "uv" {
        let mut s = status.lock().await;
        s.error = Some(
            "Could not find 'uv' (Python package manager). \
             Install it from https://astral.sh/uv then relaunch."
                .into(),
        );
        return;
    }

    let mut project_root = find_project_root();

    if project_root.is_none() {
        // Auto-clone on first launch
        let git_bin = resolve_bin("git");

        // Check that git is installed
        if !std::path::Path::new(&git_bin).exists() && git_bin == "git" {
            let mut s = status.lock().await;
            s.error = Some(
                "Could not find 'git'. \
                 Install it from https://git-scm.com then relaunch."
                    .into(),
            );
            return;
        }

        let target_path = std::path::PathBuf::from(home_dir()).join("OpenJarvis");
        let clone_target = target_path.display().to_string();

        // If the directory exists but is not a valid project, don't overwrite
        if target_path.exists() && !target_path.join("pyproject.toml").exists() {
            let mut s = status.lock().await;
            s.error = Some(format!(
                "{} exists but is not a valid OpenJarvis project. \
                 Remove it and relaunch, or set OPENJARVIS_ROOT to the correct path.",
                clone_target,
            ));
            return;
        }

        {
            let mut s = status.lock().await;
            s.detail = "Downloading OpenJarvis (first launch)...".into();
        }

        let clone_result = tokio::process::Command::new(&git_bin)
            .args([
                "clone",
                "--depth",
                "1",
                "https://github.com/open-jarvis/OpenJarvis.git",
                &clone_target,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn();

        match clone_result {
            Ok(child) => match child.wait_with_output().await {
                Ok(output) if output.status.success() => {
                    project_root = Some(target_path);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let mut s = status.lock().await;
                    s.error = Some(format!(
                        "Failed to download OpenJarvis: {}. \
                         Clone manually: git clone https://github.com/open-jarvis/OpenJarvis.git {}",
                        stderr.trim(),
                        clone_target,
                    ));
                    return;
                }
                Err(e) => {
                    let mut s = status.lock().await;
                    s.error = Some(format!(
                        "Failed to download OpenJarvis: {}. \
                         Clone manually: git clone https://github.com/open-jarvis/OpenJarvis.git {}",
                        e, clone_target,
                    ));
                    return;
                }
            },
            Err(e) => {
                let mut s = status.lock().await;
                s.error = Some(format!(
                    "Could not run git: {}. \
                     Install git from https://git-scm.com then relaunch.",
                    e,
                ));
                return;
            }
        }
    }

    // Kill any leftover server on our port from a previous run
    {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        if client
            .get(format!("http://127.0.0.1:{}/health", JARVIS_PORT))
            .send()
            .await
            .is_ok()
        {
            // Something is already listening — try to kill it
            #[cfg(unix)]
            {
                let _ = tokio::process::Command::new("fuser")
                    .args(["-k", &format!("{}/tcp", JARVIS_PORT)])
                    .output()
                    .await;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            #[cfg(target_os = "windows")]
            {
                // Find the PID holding the port via netstat, then kill it
                if let Ok(output) = tokio::process::Command::new("cmd")
                    .args(["/C", &format!(
                        "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{port} ^| findstr LISTENING') do taskkill /PID %a /F",
                        port = JARVIS_PORT,
                    )])
                    .output()
                    .await
                {
                    let _ = output; // best-effort
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    // Start with STARTUP_MODEL (just pulled) or preferred if already available.
    let pref = preferred_model();
    let startup_model = if ollama_has_model(pref).await {
        pref
    } else if ollama_has_model(STARTUP_MODEL).await {
        STARTUP_MODEL
    } else {
        FALLBACK_MODEL
    };

    let root = project_root.as_ref().unwrap();

    // Install dependencies automatically (handles fresh clones)
    {
        let mut s = status.lock().await;
        s.detail = "Installing dependencies...".into();
    }
    let _ = tokio::process::Command::new(&uv_bin)
        .args([
            "sync",
            "--extra", "server",
            "--extra", "inference-cloud",
            "--extra", "inference-google",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .current_dir(root)
        .status()
        .await;

    {
        let mut s = status.lock().await;
        s.detail = format!(
            "Starting server with {} from {}...",
            startup_model,
            root.display(),
        );
    }

    let mut cmd = tokio::process::Command::new(&uv_bin);
    cmd.args([
        "run",
        "jarvis",
        "serve",
        "--port",
        &JARVIS_PORT.to_string(),
        "--model",
        startup_model,
        "--agent",
        "simple",
    ])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped())
    .current_dir(root);

    // Inject cloud API keys from ~/.openjarvis/cloud-keys.env
    for (key, value) in read_cloud_keys() {
        cmd.env(&key, &value);
    }
    let jarvis_child = cmd.spawn();

    match jarvis_child {
        Ok(child) => {
            backend.lock().await.jarvis = Some(ChildHandle { child });
        }
        Err(e) => {
            let mut s = status.lock().await;
            s.error = Some(format!(
                "Could not start jarvis server: {}. \
                 Make sure uv is installed (https://astral.sh/uv) and the OpenJarvis repo is cloned at {}",
                e,
                root.display(),
            ));
            return;
        }
    }

    let server_url = format!("http://127.0.0.1:{}/health", JARVIS_PORT);
    let server_ok = wait_for_url(&server_url, Duration::from_secs(600)).await;

    if !server_ok {
        // Try to read stderr from the failed process for a useful error
        let mut stderr_msg = String::new();
        {
            let mut mgr = backend.lock().await;
            if let Some(ref mut h) = mgr.jarvis {
                if let Some(ref mut stderr) = h.child.stderr.take() {
                    use tokio::io::AsyncReadExt;
                    let mut buf = vec![0u8; 4096];
                    if let Ok(n) = stderr.read(&mut buf).await {
                        stderr_msg = String::from_utf8_lossy(&buf[..n]).to_string();
                    }
                }
            }
        }
        let detail = if stderr_msg.is_empty() {
            format!(
                "Jarvis server did not start. Check that:\n\
                 1. uv is installed ({})\n\
                 2. The OpenJarvis repo is at {}\n\
                 3. Run 'uv sync' in that directory",
                uv_bin,
                root.display(),
            )
        } else {
            format!("Server failed to start: {}", stderr_msg.trim())
        };
        let mut s = status.lock().await;
        s.error = Some(detail);
        return;
    }

    {
        let mut s = status.lock().await;
        s.server_ready = true;
        s.phase = "ready".into();
        s.detail = "All systems ready.".into();
    }

    // Phase 4: Pull remaining Qwen3.5 models in the background.
    // The app is already usable with qwen3.5:2b; as each model finishes
    // it appears in the model list automatically.
    let fitting = models_that_fit();
    tokio::spawn(async move {
        for model in fitting {
            if model != STARTUP_MODEL && model != FALLBACK_MODEL {
                if !ollama_has_model(model).await {
                    let _ = pull_model(model).await;
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn api_base() -> String {
    format!("http://127.0.0.1:{}", JARVIS_PORT)
}

#[tauri::command]
async fn get_setup_status(state: tauri::State<'_, SharedStatus>) -> Result<SetupStatus, String> {
    Ok(state.lock().await.clone())
}

#[tauri::command]
fn get_api_base() -> String {
    api_base()
}

#[tauri::command]
async fn start_backend(
    backend: tauri::State<'_, SharedBackend>,
    status: tauri::State<'_, SharedStatus>,
) -> Result<(), String> {
    let b = backend.inner().clone();
    let s = status.inner().clone();
    tauri::async_runtime::spawn(boot_backend(b, s));
    Ok(())
}

#[tauri::command]
async fn stop_backend(backend: tauri::State<'_, SharedBackend>) -> Result<(), String> {
    backend.lock().await.stop_all().await;
    Ok(())
}

#[tauri::command]
async fn check_health(api_url: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/health",
        if api_url.is_empty() {
            api_base()
        } else {
            api_url
        }
    );
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_energy(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/telemetry/energy", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_telemetry(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/telemetry/stats", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_traces(api_url: String, limit: u32) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/traces?limit={}", base, limit))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_trace(api_url: String, trace_id: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/traces/{}", base, trace_id))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_learning_stats(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/learning/stats", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_learning_policy(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/learning/policy", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_memory_stats(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/memory/stats", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn search_memory(
    api_url: String,
    query: String,
    top_k: u32,
) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/memory/search", base))
        .json(&serde_json::json!({"query": query, "top_k": top_k}))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_agents(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/agents", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn fetch_models(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/models", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[derive(serde::Serialize)]
struct MemoryStatus {
    vault_path: String,
    inbox_path: String,
    long_term_path: String,
    profile_path: String,
    db_path: String,
    inbox_modified: Option<u64>,
    long_term_modified: Option<u64>,
    profile_modified: Option<u64>,
    db_modified: Option<u64>,
    needs_sync: bool,
}

#[tauri::command]
async fn chat_completion(
    api_url: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", base))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, detail));
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
async fn run_jarvis_command(args: Vec<String>) -> Result<String, String> {
    let mut cmd_args = vec!["run".to_string(), "jarvis".to_string()];
    cmd_args.extend(args);
    let uv_bin = resolve_bin("uv");
    let output = tokio::process::Command::new(&uv_bin)
        .args(&cmd_args)
        .output()
        .await
        .map_err(|e| format!("Failed to launch jarvis: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
async fn fetch_savings(api_url: String) -> Result<serde_json::Value, String> {
    let base = if api_url.is_empty() {
        api_base()
    } else {
        api_url
    };
    let resp = reqwest::get(format!("{}/v1/savings", base))
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

/// Transcribe audio via the speech API endpoint.
#[tauri::command]
async fn transcribe_audio(
    api_url: String,
    audio_data: Vec<u8>,
    filename: String,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/v1/speech/transcribe", api_url);
    let client = reqwest::Client::new();

    let part = reqwest::multipart::Part::bytes(audio_data)
        .file_name(filename)
        .mime_str("audio/webm")
        .map_err(|e| format!("Failed to create multipart: {}", e))?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;
    Ok(body)
}

/// Submit savings to Supabase leaderboard.
#[tauri::command]
async fn submit_savings(
    supabase_url: String,
    supabase_key: String,
    payload: serde_json::Value,
) -> Result<bool, String> {
    if supabase_url.is_empty() || supabase_key.is_empty() {
        return Ok(false);
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "{}/rest/v1/savings_entries?on_conflict=anon_id",
            supabase_url
        ))
        .header("Content-Type", "application/json")
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {}", supabase_key))
        .header("Prefer", "resolution=merge-duplicates")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Supabase POST failed: {}", e))?;
    Ok(resp.status().is_success())
}

// ---------------------------------------------------------------------------
// Cloud API key management
// ---------------------------------------------------------------------------

/// Path to the cloud keys file (~/.openjarvis/cloud-keys.env).
fn cloud_keys_path() -> std::path::PathBuf {
    let home = home_dir();
    std::path::PathBuf::from(home)
        .join(".openjarvis")
        .join("cloud-keys.env")
}

/// Read cloud keys from disk and return as key=value pairs.
fn read_cloud_keys() -> Vec<(String, String)> {
    let path = cloud_keys_path();
    let mut keys = Vec::new();
    if let Ok(contents) = std::fs::read_to_string(&path) {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                keys.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
    }
    keys
}

/// Save a single cloud API key to the keys file.
#[tauri::command]
async fn save_cloud_key(key_name: String, key_value: String) -> Result<(), String> {
    let path = cloud_keys_path();
    // Ensure directory exists
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Read existing keys, update/add the one being saved
    let mut keys: Vec<(String, String)> = read_cloud_keys()
        .into_iter()
        .filter(|(k, _)| k != &key_name)
        .collect();
    if !key_value.is_empty() {
        keys.push((key_name, key_value));
    }

    // Write back
    let content: String = keys
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, content + "\n").map_err(|e| format!("Failed to save key: {}", e))?;

    // Set permissions to owner-only (chmod 600)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    // Tell the running server to hot-reload its cloud engine so the user
    // doesn't need to restart the app after entering an API key.
    let reload_url = format!("http://127.0.0.1:{}/v1/cloud/reload", JARVIS_PORT);
    let _ = reqwest::Client::new()
        .post(&reload_url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    Ok(())
}

/// Get which cloud providers have keys configured (without exposing values).
#[tauri::command]
async fn get_cloud_key_status() -> Result<serde_json::Value, String> {
    let keys = read_cloud_keys();
    let status: Vec<serde_json::Value> = keys
        .iter()
        .map(|(k, v)| serde_json::json!({ "key": k, "set": !v.is_empty() }))
        .collect();
    Ok(serde_json::json!(status))
}

/// Pull a model via Ollama (called from frontend download button).
#[tauri::command]
async fn pull_ollama_model(model_name: String) -> Result<serde_json::Value, String> {
    pull_model(&model_name)
        .await
        .map_err(|e| format!("Failed to pull {}: {}", model_name, e))?;
    Ok(serde_json::json!({"status": "ok", "model": model_name}))
}

/// Delete a model from Ollama.
#[tauri::command]
async fn delete_ollama_model(model_name: String) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}/api/delete", OLLAMA_PORT);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .delete(&url)
        .json(&serde_json::json!({"name": model_name}))
        .send()
        .await
        .map_err(|e| format!("Delete failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Delete returned status {}", resp.status()));
    }
    Ok(serde_json::json!({"status": "deleted", "model": model_name}))
}

/// Check speech backend health.
#[tauri::command]
async fn speech_health(api_url: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/v1/speech/health", api_url);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;
    Ok(body)
}

/// Speak text through the native operating-system voice.
///
/// WebView2's browser speech synthesis can be unreliable in packaged Tauri
/// builds. On Windows we use the built-in SAPI voice via PowerShell instead.
#[tauri::command]
async fn speak_text(
    text: String,
    voice_name: Option<String>,
    rate: Option<i32>,
    volume: Option<i32>,
) -> Result<(), String> {
    let text: String = text.trim().chars().take(1200).collect();
    if text.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        if voice_name.as_deref() == Some("Kokoro George UK") {
            let home = home_dir();
            let python = std::path::PathBuf::from(r"C:\Dev\OpenJarvis")
                .join(".venv")
                .join("Scripts")
                .join("python.exe");
            let script_path = std::path::PathBuf::from(&home).join("openjarvis_kokoro_tts.py");
            if python.exists() && script_path.exists() {
                let ps_script = r#"
$text = $env:OPENJARVIS_TTS_TEXT
$python = $env:OPENJARVIS_KOKORO_PYTHON
$script = $env:OPENJARVIS_KOKORO_SCRIPT
$out = Join-Path $env:TEMP ("openjarvis-kokoro-" + [guid]::NewGuid().ToString() + ".wav")
try {
    & $python $script --text $text --output $out --voice bm_george --speed 0.92
    if ($LASTEXITCODE -eq 0 -and (Test-Path $out)) {
        $player = New-Object System.Media.SoundPlayer $out
        $player.PlaySync()
    }
} finally {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
}
"#;
                tokio::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-WindowStyle",
                        "Hidden",
                        "-Command",
                        ps_script,
                    ])
                    .env("OPENJARVIS_TTS_TEXT", text)
                    .env("OPENJARVIS_KOKORO_PYTHON", python.to_string_lossy().to_string())
                    .env("OPENJARVIS_KOKORO_SCRIPT", script_path.to_string_lossy().to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("Failed to start Kokoro TTS: {}", e))?;
                return Ok(());
            }
        }

        if voice_name.as_deref() == Some("Piper Alan UK") {
            let home = home_dir();
            let piper = std::path::PathBuf::from(&home)
                .join(".openjarvis-local")
                .join("tts")
                .join("piper")
                .join("piper")
                .join("piper.exe");
            let model = std::path::PathBuf::from(&home)
                .join(".openjarvis-local")
                .join("tts")
                .join("voices")
                .join("en_GB-alan-medium")
                .join("en_GB-alan-medium.onnx");
            if piper.exists() && model.exists() {
                let script = r#"
$text = $env:OPENJARVIS_TTS_TEXT
$piper = $env:OPENJARVIS_PIPER_EXE
$model = $env:OPENJARVIS_PIPER_MODEL
$out = Join-Path $env:TEMP ("openjarvis-tts-" + [guid]::NewGuid().ToString() + ".wav")
try {
    $text | & $piper --model $model --output_file $out --length_scale 1.18 --noise_scale 0.58 --noise_w 0.72 --sentence_silence 0.28 --quiet
    Add-Type -AssemblyName System.Windows.Forms
    $player = New-Object System.Media.SoundPlayer $out
    $player.PlaySync()
} finally {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
}
"#;
                tokio::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-WindowStyle",
                        "Hidden",
                        "-Command",
                        script,
                    ])
                    .env("OPENJARVIS_TTS_TEXT", text)
                    .env("OPENJARVIS_PIPER_EXE", piper.to_string_lossy().to_string())
                    .env("OPENJARVIS_PIPER_MODEL", model.to_string_lossy().to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("Failed to start Piper TTS: {}", e))?;
                return Ok(());
            }
        }

        let script = r#"
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voiceName = $env:OPENJARVIS_TTS_VOICE
if ($voiceName) {
    try { $synth.SelectVoice($voiceName) } catch {}
}
$rate = 0
if ([int]::TryParse($env:OPENJARVIS_TTS_RATE, [ref]$rate)) {
    $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $rate))
}
$volume = 100
if ([int]::TryParse($env:OPENJARVIS_TTS_VOLUME, [ref]$volume)) {
    $synth.Volume = [Math]::Max(0, [Math]::Min(100, $volume))
}
$synth.Speak($env:OPENJARVIS_TTS_TEXT)
"#;
        tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .env("OPENJARVIS_TTS_TEXT", text)
            .env("OPENJARVIS_TTS_VOICE", voice_name.unwrap_or_default())
            .env("OPENJARVIS_TTS_RATE", rate.unwrap_or(0).to_string())
            .env("OPENJARVIS_TTS_VOLUME", volume.unwrap_or(100).to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start Windows TTS: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Native TTS is only implemented for Windows desktop builds.".into())
    }
}

#[tauri::command]
async fn stop_tts() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq 'powershell.exe' -and (
      $_.CommandLine -like '*OPENJARVIS_TTS_TEXT*' -or
      $_.CommandLine -like '*openjarvis_kokoro_tts.py*' -or
      $_.CommandLine -like '*openjarvis-tts-*' -or
      $_.CommandLine -like '*openjarvis-kokoro-*'
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -eq 'python.exe' -or $_.Name -eq 'piper.exe') -and (
      $_.CommandLine -like '*openjarvis_kokoro_tts.py*' -or
      $_.CommandLine -like '*en_GB-alan-medium.onnx*'
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"#;
        tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to stop TTS: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

#[tauri::command]
async fn list_tts_voices() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
@($synth.GetInstalledVoices() | ForEach-Object {
    $info = $_.VoiceInfo
    [PSCustomObject]@{
        name = $info.Name
        culture = $info.Culture.Name
        gender = $info.Gender.ToString()
        age = $info.Age.ToString()
    }
}) | ConvertTo-Json -Compress
"#;
        let output = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to list Windows TTS voices: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let mut voices: Vec<serde_json::Value> = if stdout.is_empty() {
            Vec::new()
        } else {
            match serde_json::from_str::<serde_json::Value>(&stdout)
                .map_err(|e| format!("Invalid voice list: {}", e))?
            {
                serde_json::Value::Array(items) => items,
                item => vec![item],
            }
        };

        let home = home_dir();
        let piper = std::path::PathBuf::from(&home)
            .join(".openjarvis-local")
            .join("tts")
            .join("piper")
            .join("piper")
            .join("piper.exe");
        let model = std::path::PathBuf::from(&home)
            .join(".openjarvis-local")
            .join("tts")
            .join("voices")
            .join("en_GB-alan-medium")
            .join("en_GB-alan-medium.onnx");
        if piper.exists() && model.exists() {
            voices.insert(
                0,
                serde_json::json!({
                    "name": "Piper Alan UK",
                    "culture": "en-GB",
                    "gender": "Male",
                    "age": "Adult"
                }),
            );
        }
        let kokoro_script = std::path::PathBuf::from(&home).join("openjarvis_kokoro_tts.py");
        let kokoro_python = std::path::PathBuf::from(r"C:\Dev\OpenJarvis")
            .join(".venv")
            .join("Scripts")
            .join("python.exe");
        if kokoro_script.exists() && kokoro_python.exists() {
            voices.insert(
                0,
                serde_json::json!({
                    "name": "Kokoro George UK",
                    "culture": "en-GB",
                    "gender": "Male",
                    "age": "Adult"
                }),
            );
        }
        Ok(serde_json::Value::Array(voices))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!([]))
    }
}

#[tauri::command]
async fn play_voice_cue(kind: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (frequency, duration) = match kind.as_str() {
            "start" => (880, 90),
            "stop" => (520, 110),
            "error" => (300, 180),
            _ => (700, 80),
        };
        let script = format!("[Console]::Beep({}, {})", frequency, duration);
        tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to play voice cue: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = kind;
        Ok(())
    }
}

#[tauri::command]
async fn play_wake_ack() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let wav = std::path::PathBuf::from(home_dir())
            .join(".openjarvis-local")
            .join("tts")
            .join("wake-yes-sir.wav");
        if !wav.exists() {
            return Err(format!("Wake acknowledgement missing: {}", wav.display()));
        }
        let script = r#"
$wav = $env:OPENJARVIS_WAKE_ACK
if (Test-Path $wav) {
    $player = New-Object System.Media.SoundPlayer $wav
    $player.PlaySync()
}
"#;
        tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .env("OPENJARVIS_WAKE_ACK", wav.to_string_lossy().to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to play wake acknowledgement: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

#[tauri::command]
async fn remember_text(text: String) -> Result<(), String> {
    run_brain_text_command("add", &text).await
}

#[tauri::command]
async fn promote_memory_text(text: String) -> Result<(), String> {
    run_brain_text_command("promote", &text).await
}

#[tauri::command]
async fn open_memory_target(target: String) -> Result<(), String> {
    let brain_dir = memory_brain_dir();
    let path = match target.as_str() {
        "vault" => brain_dir,
        "inbox" => brain_dir.join("00_Inbox").join("Inbox.md"),
        "long_term" => brain_dir.join("30_Memory").join("LongTermMemory.md"),
        "profile" => brain_dir.join("10_Profile").join("Leonn.md"),
        _ => return Err(format!("Unknown memory target: {}", target)),
    };

    if !path.exists() {
        return Err(format!("Memory target not found: {}", path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open memory target: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening memory files is only implemented for Windows desktop builds.".into())
    }
}

#[tauri::command]
async fn open_local_target(target: String) -> Result<(), String> {
    let home = std::path::PathBuf::from(home_dir());
    let path = match target.as_str() {
        "repo" => std::path::PathBuf::from(r"C:\Dev\OpenJarvis"),
        "config" => home.join(".openjarvis").join("config.toml"),
        "backend_log" => home.join("openjarvis-backend.log"),
        "backend_error_log" => home.join("openjarvis-backend.err.log"),
        "watchdog_log" => home.join("openjarvis-watchdog.log"),
        "startup" => home
            .join("AppData")
            .join("Roaming")
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup"),
        _ => return Err(format!("Unknown local target: {}", target)),
    };

    if !path.exists() {
        return Err(format!("Local target not found: {}", path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open local target: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening local targets is only implemented for Windows desktop builds.".into())
    }
}

#[tauri::command]
async fn get_memory_status() -> Result<MemoryStatus, String> {
    let brain_dir = memory_brain_dir();
    let inbox = brain_dir.join("00_Inbox").join("Inbox.md");
    let long_term = brain_dir.join("30_Memory").join("LongTermMemory.md");
    let profile = brain_dir.join("10_Profile").join("Leonn.md");
    let db = brain_dir.join("openjarvis-memory.db");

    let inbox_modified = modified_unix_seconds(&inbox);
    let long_term_modified = modified_unix_seconds(&long_term);
    let profile_modified = modified_unix_seconds(&profile);
    let db_modified = modified_unix_seconds(&db);
    let newest_markdown = [inbox_modified, long_term_modified, profile_modified]
        .into_iter()
        .flatten()
        .max();
    let needs_sync = match (newest_markdown, db_modified) {
        (Some(md), Some(db_time)) => md > db_time,
        (Some(_), None) => true,
        _ => false,
    };

    Ok(MemoryStatus {
        vault_path: brain_dir.display().to_string(),
        inbox_path: inbox.display().to_string(),
        long_term_path: long_term.display().to_string(),
        profile_path: profile.display().to_string(),
        db_path: db.display().to_string(),
        inbox_modified,
        long_term_modified,
        profile_modified,
        db_modified,
        needs_sync,
    })
}

#[tauri::command]
async fn sync_memory_brain() -> Result<(), String> {
    let sync_script = std::path::PathBuf::from(home_dir()).join("sync-openjarvis-brain.ps1");
    if !sync_script.exists() {
        return Err(format!("Brain sync script not found: {}", sync_script.display()));
    }

    let output = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            sync_script.to_string_lossy().as_ref(),
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run brain sync: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

fn memory_brain_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(home_dir())
        .join("Documents")
        .join("Obsidian Vault")
        .join("Jarvis")
}

fn modified_unix_seconds(path: &std::path::Path) -> Option<u64> {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

async fn run_brain_text_command(command: &str, text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Nothing to store.".into());
    }

    if command != "add" && command != "promote" {
        return Err(format!("Unsupported brain command: {}", command));
    }

    let brain_script = std::path::PathBuf::from(home_dir()).join("jarvis-brain.ps1");
    if !brain_script.exists() {
        return Err(format!("Brain script not found: {}", brain_script.display()));
    }

    let output = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            brain_script.to_string_lossy().as_ref(),
            command,
            text,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run brain script: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend: SharedBackend = Arc::new(Mutex::new(BackendManager::default()));
    let status: SharedStatus = Arc::new(Mutex::new(SetupStatus::default()));

    let boot_backend_ref = backend.clone();
    let boot_status_ref = status.clone();
    let push_to_talk_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyJ);
    let global_shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(push_to_talk_shortcut)
        .expect("failed to configure push-to-talk shortcut")
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit("openjarvis-push-to-talk", ());
            }
        })
        .build();

    tauri::Builder::default()
        .manage(backend.clone())
        .manage(status.clone())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(global_shortcut_plugin)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        // .plugin(tauri_plugin_updater::Builder::new().build()) // disabled for local dev
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            // System tray
            let show = MenuItemBuilder::with_id("show", "Show / Hide").build(app)?;
            let health = MenuItemBuilder::with_id("health", "Health: starting...")
                .enabled(false)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit OpenJarvis").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&health)
                .separator()
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenJarvis")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Auto-start backend services on launch
            tauri::async_runtime::spawn(boot_backend(boot_backend_ref, boot_status_ref));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_setup_status,
            get_api_base,
            start_backend,
            stop_backend,
            check_health,
            fetch_energy,
            fetch_telemetry,
            fetch_traces,
            fetch_trace,
            fetch_learning_stats,
            fetch_learning_policy,
            fetch_memory_stats,
            search_memory,
            fetch_agents,
            fetch_models,
            chat_completion,
            run_jarvis_command,
            fetch_savings,
            submit_savings,
            transcribe_audio,
            speech_health,
            pull_ollama_model,
            delete_ollama_model,
            save_cloud_key,
            get_cloud_key_status,
            speak_text,
            stop_tts,
            list_tts_voices,
            play_voice_cue,
            play_wake_ack,
            remember_text,
            promote_memory_text,
            open_memory_target,
            open_local_target,
            get_memory_status,
            sync_memory_brain,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpenJarvis Desktop")
        .run(move |_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let b = backend.clone();
                tauri::async_runtime::spawn(async move {
                    b.lock().await.stop_all().await;
                });
            }
        });
}
