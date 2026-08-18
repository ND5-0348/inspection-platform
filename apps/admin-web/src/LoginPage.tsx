import { FormEvent, useState } from "react";
import { api, type AuthUser } from "./api";

export function LoginPage({ onLoggedIn }: { onLoggedIn: (user: AuthUser) => void }) {
  const [employeeNo, setEmployeeNo] = useState("S001");
  const [password, setPassword] = useState("Sampler@123");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function useDemo(role: "admin" | "sampler") {
    if (role === "admin") {
      setEmployeeNo("A001");
      setPassword("Admin@123");
    } else {
      setEmployeeNo("S001");
      setPassword("Sampler@123");
    }
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLoggedIn(await api.login(employeeNo, password));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand"><span className="brand-mark">检</span><div><strong>抽检云台</strong><small>INSPECTION OPERATIONS</small></div></div>
        <div className="story-copy">
          <p className="eyebrow">REMOTE QUALITY CONTROL</p>
          <h1>一次登录，连接派单与现场抽样</h1>
          <p>管理员负责规则与任务，抽样员可以从网页或微信小程序接单。每次随机选择都会留下可追溯记录。</p>
        </div>
        <div className="story-flow"><span>01 创建检测单</span><i /><span>02 随机派发</span><i /><span>03 现场抽样</span></div>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-box">
          <p className="eyebrow">WELCOME BACK</p>
          <h2 id="login-title">登录工作台</h2>
          <p className="login-help">使用企业工号进入对应的工作页面</p>
          <form onSubmit={(event) => void submit(event)}>
            <label>企业工号<input autoComplete="username" required value={employeeNo} onChange={(event) => setEmployeeNo(event.target.value.toUpperCase())} placeholder="例如 S001" /></label>
            <label>登录密码<input autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {error && <div className="login-error" role="alert">{error}</div>}
            <button className="primary-button login-submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
          </form>
          <div className="demo-accounts">
            <span>本机演示身份</span>
            <button type="button" onClick={() => useDemo("sampler")}>抽样员 S001</button>
            <button type="button" onClick={() => useDemo("admin")}>管理员 A001</button>
          </div>
          <p className="security-note">本机开发环境 · 正式上线前将接入企业账号和微信身份绑定</p>
        </div>
      </section>
    </main>
  );
}

