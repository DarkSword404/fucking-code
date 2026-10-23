import { Show, createSignal, onMount } from "solid-js";
import { api, ApiError, type AuthConfig } from "../lib/api";
import { login, register } from "../lib/store";

export function AuthScreen() {
  const [mode, setMode] = createSignal<"login" | "register">("login");
  const [config, setConfig] = createSignal<AuthConfig | null>(null);
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [invite, setInvite] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void api
      .authConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  });

  const registrationEnabled = () => config()?.registrationEnabled ?? false;
  const canSubmit = () =>
    Boolean(email().trim()) &&
    Boolean(password()) &&
    (mode() === "login" || (Boolean(displayName().trim()) && Boolean(invite().trim())));

  async function submit(event: Event) {
    event.preventDefault();
    if (!canSubmit() || busy()) return;
    setError(null);
    setBusy(true);
    try {
      if (mode() === "login") {
        await login(email().trim(), password());
      } else {
        await register({
          email: email().trim(),
          password: password(),
          displayName: displayName().trim(),
          inviteCode: invite().trim(),
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="brand-mark">FC</div>
          <div>
            <div class="auth-title">Fucking Code</div>
            <div class="auth-sub">AI 研发团队</div>
          </div>
        </div>
        <p class="auth-intro">
          把 AI 研发团队变成你的乙方。
          <br />
          登录后你会得到独立的工作区和项目。
        </p>

        <div class="auth-tabs">
          <button
            class={`auth-tab ${mode() === "login" ? "active" : ""}`}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
          >
            登录
          </button>
          <Show when={registrationEnabled()}>
            <button
              class={`auth-tab ${mode() === "register" ? "active" : ""}`}
              onClick={() => {
                setMode("register");
                setError(null);
              }}
            >
              注册
            </button>
          </Show>
        </div>

        <form onSubmit={submit}>
          <Show when={mode() === "register"}>
            <div class="field">
              <label>你的名字</label>
              <input
                autocomplete="name"
                placeholder="团队里怎么称呼你"
                value={displayName()}
                onInput={(event) => setDisplayName(event.currentTarget.value)}
              />
            </div>
          </Show>
          <div class="field">
            <label>邮箱</label>
            <input
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label>密码</label>
            <input
              type="password"
              autocomplete={mode() === "login" ? "current-password" : "new-password"}
              placeholder={mode() === "register" ? "至少 8 位" : "输入密码"}
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
          <Show when={mode() === "register"}>
            <div class="field">
              <label>邀请码</label>
              <input
                placeholder="向管理员索取"
                value={invite()}
                onInput={(event) => setInvite(event.currentTarget.value)}
              />
            </div>
          </Show>

          <Show when={error()}>
            <div class="auth-error">{error()}</div>
          </Show>

          <button class="btn primary auth-submit" type="submit" disabled={busy() || !canSubmit()}>
            {busy() ? "请稍候…" : mode() === "login" ? "登录" : "创建账号"}
          </button>
        </form>

        <Show when={config() !== null && !registrationEnabled()}>
          <div class="auth-hint">
            注册未开放。请联系管理员索取邀请码，或使用已有账号登录。
          </div>
        </Show>
        <Show when={config()?.authMode === "dev"}>
          <div class="auth-hint">
            当前是本地开发模式，通常会自动登录。看到这个页面说明会话配置异常。
          </div>
        </Show>
      </div>
    </div>
  );
}
