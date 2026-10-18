import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Step = {
  node: string;
  action: string;
  message: string;
  source: string;
  at: string;
};
type Trace = {
  id: string;
  instance: string;
  method: string;
  path: string;
  status: number;
  startedAt: string;
  steps: Step[];
};
type User = {
  loginId: string;
  grantId: string;
  sessionRecordId: string;
  method: string;
  instance: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  passwordVerifiedAt: number;
  rememberExpiresAt?: string;
};
const run = new URLSearchParams(location.search).get("run") || "studio";
const when = (v: any) =>
  v ? new Date(v).toLocaleTimeString("ko-KR", { hour12: false }) : "—";
function App() {
  const [user, setUser] = useState<User | null>(null),
    [node, setNode] = useState("A"),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [device, setDevice] = useState("나의 브라우저"),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("실제 서버 연결을 준비하고 있습니다."),
    [uncertain, setUncertain] = useState(false),
    [snapshot, setSnapshot] = useState<any>(null),
    [traces, setTraces] = useState<Trace[]>([]),
    [selected, setSelected] = useState<Trace | null>(null),
    [step, setStep] = useState(0),
    [playing, setPlaying] = useState(false),
    [sources, setSources] = useState<any>({}),
    [notifications, setNotifications] = useState(true),
    [tick, setTick] = useState(Date.now()),
    [tab, setTab] = useState("service");
  const [scenario, setScenario] = useState("normal"),
    [labBusy, setLabBusy] = useState(false),
    [results, setResults] = useState<any>({ status: "not-run", tests: [] }),
    [dropNext, setDropNext] = useState(false);
  const drop = useRef(false);
  const csrf = useRef("");
  const [devices, setDevices] = useState<any[] | null>(null),
    [pending, setPending] = useState<any>(null),
    [confirmPassword, setConfirmPassword] = useState(""),
    [confirmError, setConfirmError] = useState("");
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel("loginlab-" + run);
    channel.current = c;
    c.onmessage = (e) => {
      if (e.data === "logout") {
        setUser(null);
        setDevices(null);
        setNotice("다른 탭에서 로그아웃했습니다.");
        prepare().catch(() => {});
      }
    };
    return () => c.close();
  }, []);
  const lab = async (path: string, body?: any) => {
    const r = await fetch("/lab/" + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Lab-Control": "1", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw Error("관찰 결과 확인 불가");
    return r.json();
  };
  async function observe(selectId?: string) {
    try {
      const [s, t] = await Promise.all([
        lab("snapshot?run=" + run),
        lab("traces?run=" + run),
      ]);
      setSnapshot(s);
      setTraces(t);
      if (selectId) {
        const found = t.find((e: Trace) => e.id === selectId);
        if (found) {
          setSelected(found);
          setStep(0);
          setPlaying(true);
        }
      }
    } catch {
      setNotice("관찰 서버에 연결할 수 없습니다.");
    }
  }
  async function api(
    path: string,
    method = "GET",
    body?: any,
    collect = true,
    retryCsrf = true,
  ) {
    const id = crypto.randomUUID();
    const dropping =
      drop.current && method !== "GET" && path.startsWith("auth/");
    if (dropping) {
      drop.current = false;
      setDropNext(false);
    }
    let response: Response;
    try {
      response = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Lab-Run": run,
          "X-Lab-Node": node,
          "X-Request-Id": id,
          ...(dropping ? { "X-Lab-Drop-Response": "1" } : {}),
          ...(csrf.current ? { "X-CSRF-TOKEN": csrf.current } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (collect) await observe(id);
      throw error;
    }
    const data = response.status === 204 ? null : await response.json();
    if (collect) await observe(id);
    if (
      response.status === 403 &&
      data?.code === "CSRF_INVALID" &&
      retryCsrf &&
      method !== "GET"
    ) {
      await prepare();
      return api(path, method, body, collect, false);
    }
    if (response.status >= 500) setUncertain(true);
    else setUncertain(false);
    return { response, data };
  }
  async function prepare() {
    const { response, data } = await api("auth/csrf", "GET", undefined, false);
    if (response.ok) csrf.current = data.token;
    else throw Error(data.message || "CSRF 준비 실패");
  }
  useEffect(() => {
    (async () => {
      try {
        await lab("runs", { run, policy: "normal" });
        await prepare();
        const { response, data } = await api(
          "auth/me",
          "GET",
          undefined,
          false,
        );
        if (response.ok) {
          setUser(data);
          setNotice("저장된 실제 세션을 확인했습니다.");
        } else if (response.status === 401 && data.code !== "AUTH_REVOKED") {
          if (!(await restore(false)))
            setNotice("실습 계정으로 로그인해 첫 요청을 시작하세요.");
        } else setNotice(data.message);
        await observe();
        const s = await fetch("/flow-source.json").then((r) => r.json());
        setSources(s);
      } catch {
        setUncertain(true);
        setNotice("서버 연결을 확인해 주세요.");
      }
    })();
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!playing || !selected) return;
    const t = setTimeout(() => {
      if (step >= selected.steps.length - 1) setPlaying(false);
      else setStep((i) => i + 1);
    }, 650);
    return () => clearTimeout(t);
  }, [playing, step, selected]);
  async function protectedApi(path: string, method = "GET", body?: any) {
    let r = await api(path, method, body);
    if (
      r.response.status === 401 &&
      ["SESSION_REQUIRED", "SESSION_EXPIRED"].includes(r.data?.code) &&
      (await restore(false))
    ) {
      await prepare();
      r = await api(path, method, body);
    }
    return r;
  }
  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await prepare();
      const { response, data } = await api("auth/login", "POST", {
        loginId: login,
        password,
        rememberMe: remember,
        deviceName: device,
      });
      if (response.ok) {
        setUser(data);
        setPassword("");
        await prepare();
        setNotice("로그인 완료. Redis 세션과 DB 활성 기록을 확인했습니다.");
      } else setNotice(data.message);
    } catch {
      setUncertain(true);
      setNotice("연결 결과를 확인할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function restore(announce = true) {
    try {
      await prepare();
      const { response, data } = await api("auth/restore", "POST", {});
      if (response.ok) {
        setUser(data);
        await prepare();
        setNotice("로그인 유지로 새 세션을 복원했습니다.");
        return true;
      }
      if (response.status === 409) {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const next = await api("auth/me", "GET", undefined, false);
          if (next.response.ok) {
            setUser(next.data);
            await prepare();
            setNotice("다른 탭의 복원 결과를 확인했습니다.");
            return true;
          }
        }
      }
      if (announce) setNotice(data.message);
      if (response.status < 500) setUser(null);
      return false;
    } catch {
      setUncertain(true);
      if (announce) setNotice("복원 결과를 확인할 수 없습니다.");
      return false;
    }
  }
  async function report() {
    setBusy(true);
    try {
      let { response, data } = await api("protected/report");
      if (
        response.status === 401 &&
        ["SESSION_REQUIRED", "SESSION_EXPIRED"].includes(data.code) &&
        (await restore())
      ) {
        const next = await api("protected/report");
        response = next.response;
        data = next.data;
      }
      if (response.ok) {
        setUser(data.auth);
        setNotifications(data.preferences.notifications);
        setNotice("실제 보호 API 조회 성공 · 서버 " + data.auth.instance);
      } else {
        setNotice(data.message);
        if (response.status === 401) setUser(null);
      }
    } catch {
      setUncertain(true);
      setNotice("서버 응답을 확인할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      const { response, data } = await protectedApi(
        "protected/preferences",
        "PATCH",
        { notifications: !notifications },
      );
      if (response.ok) {
        setNotifications(data.notifications);
        setNotice("DB 설정 저장 완료 · version " + data.version);
      } else {
        setNotice(data.message);
        if (response.status === 401) setUser(null);
      }
    } catch {
      setUncertain(true);
      setNotice("저장 결과 확인 불가");
    } finally {
      setBusy(false);
    }
  }
  async function loadDevices() {
    const { response, data } = await api(
      "auth/devices",
      "GET",
      undefined,
      false,
    );
    if (response.ok) setDevices(data);
    else setNotice(data.message);
  }
  async function perform(action: any) {
    setBusy(true);
    try {
      const { response, data } = await protectedApi(
        action.path,
        action.method,
        action.body || {},
      );
      if (response.status === 403 && data.code === "REAUTH_REQUIRED") {
        setPending(action);
        setConfirmError("");
        return;
      }
      if (response.ok) {
        if (action.logout) {
          setUser(null);
          setDevices(null);
          channel.current?.postMessage("logout");
          await prepare();
          setNotice(
            action.path.endsWith("logout-all")
              ? "모든 기기의 로그인 권한을 해제했습니다."
              : "현재 기기의 로그인 권한을 해제했습니다.",
          );
        } else {
          setNotice("대상 기기의 로그인 권한을 해제했습니다.");
          await loadDevices();
        }
      } else {
        setNotice(data.message);
        if (response.status === 401) setUser(null);
      }
    } catch {
      setUncertain(true);
      setNotice("처리 결과 확인 중입니다. 연결 복구 후 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { response, data } = await api("auth/reauthenticate", "POST", {
        password: confirmPassword,
      });
      setConfirmPassword("");
      if (response.ok) {
        await prepare();
        const me = await api("auth/me", "GET", undefined, false);
        if (me.response.ok) setUser(me.data);
        const next = pending;
        setPending(null);
        await perform(next);
      } else setConfirmError(data.message);
    } catch {
      setConfirmError("서버 확인 불가. 다시 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  async function refreshResults() {
    try {
      setResults(await lab("results"));
    } catch {}
  }
  useEffect(() => {
    refreshResults();
    const timer = setInterval(refreshResults, 2500);
    return () => clearInterval(timer);
  }, []);
  async function experiment() {
    setLabBusy(true);
    try {
      if (scenario === "short") {
        const next = "lab-" + Date.now();
        await lab("runs", { run: next, policy: "short" });
        location.href = "/?run=" + next;
        return;
      }
      if (scenario === "redis" || scenario === "db") {
        await lab("network", { target: scenario, down: true });
        setUncertain(true);
        setNotice(
          (scenario === "redis" ? "Redis" : "DB") +
            " 연결 경로를 차단했습니다. 보호 API로 실제 거부를 확인하세요.",
        );
        await observe();
      } else if (scenario === "prepared" || scenario === "cleanup") {
        await lab("fault", {
          run,
          point:
            scenario === "prepared"
              ? "after-redis-save"
              : "after-revoke-commit",
          mode: "fail",
        });
        setNotice("다음 해당 요청의 처리 지점에 장애를 적용했습니다.");
      } else if (scenario === "restart") {
        const r = await lab("redis-restart", { run });
        setNotice(
          "실제 Redis " +
            r.version +
            " 재시작과 이 실행의 세션 소실 완료. 다음 요청에서 재인증을 확인하세요.",
        );
        await observe();
      } else if (scenario === "node") {
        await lab("node", { node: "A", action: "restart" });
        setNotice(
          "서버 A 재시작을 요청했습니다. B로 보호 API를 조회해 세션 공유를 확인하세요.",
        );
        setNode("B");
      } else if (scenario === "restore") {
        await restore();
      } else if (scenario === "shared") {
        setNode("B");
        setNotice(
          "요청 서버를 B로 선택했습니다. 보호 API 조회로 실제 공유를 확인하세요.",
        );
      } else if (user) {
        await report();
      } else {
        document.querySelector<HTMLInputElement>(".login-form input")?.focus();
        setNotice("실습 계정을 입력하고 로그인해 주세요.");
      }
    } catch {
      setNotice("실험 제어 결과를 확인할 수 없습니다.");
    } finally {
      setLabBusy(false);
    }
  }
  async function recover() {
    setLabBusy(true);
    try {
      await lab("network", { target: "redis", down: false });
      await lab("network", { target: "db", down: false });
      for (const point of [
        "after-redis-save",
        "before-activate",
        "after-revoke-commit",
        "before-revoke-commit",
      ])
        await lab("fault", { run, point, mode: "release" });
      await new Promise((r) => setTimeout(r, 500));
      await prepare();
      const r = await api("auth/me");
      if (r.response.ok) {
        setUser(r.data);
        setNotice("연결 복구 후 실제 인증 상태를 확인했습니다.");
      } else {
        setUser(null);
        setNotice("연결을 복구했습니다. 로그인 상태를 다시 확인해 주세요.");
      }
      await observe();
    } catch {
      setUncertain(true);
      setNotice("연결 복구 결과를 확인할 수 없습니다.");
    } finally {
      setLabBusy(false);
    }
  }
  async function runTests() {
    setLabBusy(true);
    try {
      await lab("test", { stage: "full" });
      setResults({ status: "running", tests: [] });
      setNotice("실제 백엔드와 브라우저 회귀 검증을 시작했습니다.");
    } catch {
      setNotice("테스트 실행 중이거나 실행 결과를 확인할 수 없습니다.");
    } finally {
      setLabBusy(false);
    }
  }
  const current = selected?.steps[step],
    source = current ? sources[current.source] : null;
  const left = user
    ? Math.max(0, Math.ceil((Date.parse(user.idleExpiresAt) - tick) / 1000))
    : 0;
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="/">
          <span className="logo">
            S<span>·</span>
          </span>
          <div>
            SESSION LAB<small>인증 설계 실험실</small>
          </div>
        </a>
        <div className="top-meta">
          <span className="live-dot" />
          실제 백엔드 연결
          <span className="divider" />
          SPRING · REDIS · POSTGRESQL
        </div>
        <a className="doc-link" href="#record">
          실행 기록 ↗
        </a>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">01 / AUTHENTICATION</p>
            <h1>
              로그인 상태가
              <br />
              <span>만들어지는 과정.</span>
            </h1>
            <p className="lead">
              로그인 한 번에 서버는 무엇을 기억할까요?
              <br />
              직접 실행하고, 흐름을 따라가며, 데이터로 확인하세요.
            </p>
          </div>
          <aside className="intro-note">
            <span>THIS IS A REAL REQUEST</span>
            <p>
              화면의 성공 표시부터
              <br />
              DB에 남은 기록까지.
            </p>
            <small>실행 기록 기반 재생 · 인증정보 원문 비표시</small>
          </aside>
        </div>
        <div className="toolbar">
          <div className="scenario">
            <span>실험</span>
            <strong>로그인과 세션 발급</strong>
          </div>
          <label>
            요청 처리 서버
            <select
              aria-label="요청 처리 서버"
              value={node}
              onChange={(e) => setNode(e.target.value)}
            >
              <option value="A">서버 A</option>
              <option value="B">서버 B</option>
            </select>
          </label>
          <button className="plain" onClick={() => observe()}>
            관찰 새로고침 ↻
          </button>
        </div>
        <div className="mobile-tabs">
          {[
            ["service", "서비스"],
            ["flow", "흐름"],
            ["data", "데이터"],
          ].map(([v, l]) => (
            <button
              key={v}
              className={tab === v ? "active" : ""}
              onClick={() => setTab(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="workspace">
          <section
            className={
              "panel service " + (tab === "service" ? "mobile-active" : "")
            }
            aria-label="서비스 체험"
          >
            <div className="panel-heading">
              <span className="number">01</span>
              <h2>서비스 체험</h2>
              <span className={"status " + (user && !uncertain ? "on" : "")}>
                {uncertain ? "확인 불가" : user ? "인증됨" : "로그인 전"}
              </span>
            </div>
            {!user ? (
              <form onSubmit={signIn} className="login-form">
                <div className="form-title">
                  <span className="mini-icon">↳</span>
                  <h3>다시 만나 반가워요.</h3>
                  <p>실습 계정으로 인증 과정을 확인하세요.</p>
                </div>
                <label>
                  아이디
                  <input
                    aria-label="아이디"
                    autoComplete="username"
                    placeholder="name@example.com"
                    type="email"
                    required
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                  />
                </label>
                <label>
                  비밀번호
                  <input
                    aria-label="비밀번호"
                    autoComplete="current-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label>
                  기기 이름
                  <input
                    aria-label="기기 이름"
                    maxLength={60}
                    value={device}
                    onChange={(e) => setDevice(e.target.value)}
                  />
                </label>
                <label className="check">
                  <input
                    aria-label="로그인 유지"
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  <span>
                    로그인 유지 <small>고정 기간 · 기기별 해제 가능</small>
                  </span>
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? "서버 확인 중…" : "로그인하고 흐름 확인하기"}
                  <span>↗</span>
                </button>
                <button
                  className="fixture"
                  type="button"
                  onClick={() => {
                    setLogin("demo@lab.test");
                    setPassword("Lab!2026Pass");
                  }}
                >
                  실습 계정 입력 <span>demo@lab.test</span>
                </button>
              </form>
            ) : (
              <div className="account">
                <div className="avatar">{user.loginId[0].toUpperCase()}</div>
                <p className="eyebrow">AUTHENTICATED</p>
                <h3>{user.loginId}</h3>
                <p>서버 {user.instance}가 실제 인증을 확인했습니다.</p>
                <dl>
                  <div>
                    <dt>인증 방식</dt>
                    <dd>{user.method}</dd>
                  </div>
                  <div>
                    <dt>유휴 만료까지</dt>
                    <dd>{left}초</dd>
                  </div>
                  <div>
                    <dt>절대 만료</dt>
                    <dd>{when(user.absoluteExpiresAt)}</dd>
                  </div>
                  {user.rememberExpiresAt && (
                    <div>
                      <dt>로그인 유지 종료</dt>
                      <dd>
                        {new Date(user.rememberExpiresAt).toLocaleString(
                          "ko-KR",
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
                <button
                  className="primary"
                  aria-label="보호 API 조회"
                  disabled={busy}
                  onClick={report}
                >
                  보호 API 조회<span>↗</span>
                </button>
                <button className="secondary" disabled={busy} onClick={save}>
                  알림 {notifications ? "끄기" : "켜기"} · 실제 DB 저장
                </button>
                <div className="account-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={loadDevices}
                  >
                    기기 관리
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      perform({
                        path: "auth/logout",
                        method: "POST",
                        logout: true,
                      })
                    }
                  >
                    현재 기기 로그아웃
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      perform({
                        path: "auth/logout-all",
                        method: "POST",
                        logout: true,
                      })
                    }
                  >
                    모든 기기 로그아웃
                  </button>
                </div>
                {devices && (
                  <div className="device-list">
                    <h4>등록된 기기</h4>
                    {devices.map((d) => (
                      <article key={d.id}>
                        <div>
                          <strong>{d.label}</strong>
                          <small>
                            {d.current ? "현재 기기 · " : ""}
                            {d.mode} · {d.status}
                          </small>
                        </div>
                        {!d.current && d.status === "ACTIVE" && (
                          <button
                            aria-label={"기기 해제 " + d.label}
                            disabled={busy}
                            onClick={() =>
                              perform({
                                path: "auth/devices/" + d.id,
                                method: "DELETE",
                              })
                            }
                          >
                            해제
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
                <p className="quiet">
                  남은 시간은 마지막 서버 응답 기준입니다.
                  <br />
                  다음 요청에서 실제 만료 여부를 확인합니다.
                </p>
              </div>
            )}
            <div
              role="status"
              className={"notice " + (uncertain ? "warning" : "")}
            >
              {notice}
            </div>
          </section>
          <section
            className={"panel flow " + (tab === "flow" ? "mobile-active" : "")}
            aria-label="처리 흐름 시각화"
          >
            <div className="panel-heading">
              <span className="number">02</span>
              <h2>요청이 지나간 길</h2>
              <span className="muted">실행 기록</span>
            </div>
            <div className="flow-header">
              <p>
                {selected
                  ? selected.method + " " + selected.path
                  : "첫 요청을 기다립니다"}
              </p>
              <div>
                <button
                  aria-label={playing ? "흐름 일시정지" : "흐름 재생"}
                  disabled={!selected}
                  onClick={() => {
                    if (selected && step >= selected.steps.length - 1)
                      setStep(0);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? "Ⅱ" : "▷"}
                </button>
                <button
                  aria-label="흐름 처음부터"
                  disabled={!selected}
                  onClick={() => {
                    setStep(0);
                    setPlaying(true);
                  }}
                >
                  ↻
                </button>
              </div>
            </div>
            <div className="scene">
              <svg
                viewBox="0 0 450 260"
                role="img"
                aria-label="브라우저 서버 Redis DB 요청 경로"
              >
                <defs>
                  <pattern
                    id="grid"
                    width="18"
                    height="18"
                    patternUnits="userSpaceOnUse"
                  >
                    <circle cx="1" cy="1" r=".7" fill="#c9d0d7" />
                  </pattern>
                </defs>
                <rect width="450" height="260" fill="url(#grid)" />
                <path
                  d="M76 135H212 M244 126L356 72 M244 147L356 205"
                  stroke="#c3cad2"
                  strokeWidth="1.5"
                  fill="none"
                />
                {[
                  { n: "Browser", x: 64, y: 135, label: "브라우저", icon: "▣" },
                  {
                    n: "Server",
                    x: 226,
                    y: 135,
                    label: "서버 " + (selected?.instance || node),
                    icon: "⌘",
                  },
                  { n: "Redis", x: 375, y: 66, label: "Redis", icon: "≋" },
                  { n: "DB", x: 375, y: 207, label: "PostgreSQL", icon: "▤" },
                ].map((v) => (
                  <g
                    key={v.n}
                    className={
                      current?.node === v.n ? "node active-node" : "node"
                    }
                  >
                    <rect
                      x={v.x - 26}
                      y={v.y - 26}
                      width="52"
                      height="52"
                      rx="14"
                    />
                    <text
                      x={v.x}
                      y={v.y + 7}
                      className="node-icon"
                      textAnchor="middle"
                    >
                      {v.icon}
                    </text>
                    <text
                      x={v.x}
                      y={v.y + 45}
                      textAnchor="middle"
                      className="node-label"
                    >
                      {v.label}
                    </text>
                    {current?.node === v.n && (
                      <circle
                        cx={v.x + 23}
                        cy={v.y - 23}
                        r="5"
                        fill="#ecab54"
                      />
                    )}
                  </g>
                ))}
              </svg>
              <span className="scene-tag">
                {selected ? "완료된 실행 재생" : "실제 요청을 실행해 보세요"}
              </span>
            </div>
            <div className="current-step">
              <span>
                {selected ? String(step + 1).padStart(2, "0") : "00"}
                <small> / {selected?.steps.length || "00"}</small>
              </span>
              <div>
                <strong>
                  {current?.message ||
                    "로그인하면 처리 단계가 여기에 나타납니다."}
                </strong>
                <small>
                  {current?.source || "브라우저 → 서버 → 저장소 → 응답"}
                </small>
              </div>
            </div>
            <ol className="timeline">
              {selected?.steps.map((s, i) => (
                <li key={i}>
                  <button
                    className={i === step ? "chosen" : ""}
                    onClick={() => {
                      setStep(i);
                      setPlaying(false);
                    }}
                  >
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <b>{s.node}</b>
                    <span>{s.message}</span>
                  </button>
                </li>
              ))}
            </ol>
            {source && (
              <details className="source">
                <summary>
                  실제 처리 소스 · {source.file.split("/").pop()}:{source.line}
                </summary>
                <pre>{source.snippet}</pre>
              </details>
            )}
          </section>
          <aside
            className={"panel data " + (tab === "data" ? "mobile-active" : "")}
            aria-label="실제 데이터 관찰"
          >
            <div className="panel-heading">
              <span className="number">03</span>
              <h2>남겨진 데이터</h2>
            </div>
            <p className="data-description">
              별도 관찰 경로로 읽습니다.
              <br />
              세션의 활동 시간을 갱신하지 않습니다.
            </p>
            <div className="store-heading">
              <span
                className={
                  "dot " + (snapshot?.db === "available" ? "green" : "")
                }
              />
              <strong>PostgreSQL</strong>
              <small>
                {snapshot?.db === "available" ? "연결됨" : "확인 불가"}
              </small>
            </div>
            <div className="data-count">
              <span>device_auth_grants</span>
              <strong>
                {snapshot?.grants?.length ?? "—"}
                <small>rows</small>
              </strong>
            </div>
            <div className="data-count">
              <span>auth_sessions · ACTIVE</span>
              <strong>
                {snapshot?.sessions?.filter((s: any) => s.state === "ACTIVE")
                  .length ?? "—"}
                <small>rows</small>
              </strong>
            </div>
            <div className="data-count">
              <span>remember_credentials</span>
              <strong>
                {snapshot?.remember?.length ?? "—"}
                <small>rows</small>
              </strong>
            </div>
            <div className="store-heading redis-title">
              <span
                className={
                  "dot " + (snapshot?.redis === "available" ? "green" : "")
                }
              />
              <strong>Redis</strong>
              <small>
                {snapshot?.redis === "available" ? "연결됨" : "확인 불가"}
              </small>
            </div>
            <div className="redis-card">
              <span>현재 세션</span>
              <strong>
                {snapshot?.redisSessions?.filter((s: any) => s.exists).length ??
                  "—"}
              </strong>
              <small>서버 A·B가 공유하는 저장소</small>
            </div>
            <div className="redis-sessions">
              {snapshot?.redisSessions?.slice(0, 3).map((row: any) => (
                <div key={row.sessionRecordId}>
                  <code>#{row.sessionRecordId.slice(0, 8)}</code>
                  <strong>
                    {row.exists
                      ? "TTL " + row.ttlSeconds + "초"
                      : "현재 세션 없음"}
                  </strong>
                  <small>최근 활동 {when(row.lastAccessedAt)}</small>
                </div>
              ))}
            </div>
            <div className="records">
              {snapshot?.sessions?.slice(0, 4).map((s: any) => (
                <div key={s.id}>
                  <span
                    className={"state " + (s.state === "ACTIVE" ? "valid" : "")}
                  >
                    {s.state}
                  </span>
                  <code>{s.id.slice(0, 8)}</code>
                  <small>{when(s.created_at)}</small>
                </div>
              ))}
            </div>
            <p className="quiet">
              관찰 시각 {when(snapshot?.observedAt)}
              <br />
              쿠키·비밀번호·토큰 원문은 표시하지 않습니다.
            </p>
          </aside>
        </div>
        <section className="experiments" aria-label="장애와 검증 실험">
          <div className="experiment-tools">
            <p className="eyebrow">CONTROL ROOM</p>
            <h2>같은 기능, 다른 조건.</h2>
            <p>정상 흐름부터 만료와 장애까지 직접 재현합니다.</p>
            <label>
              실험 시나리오
              <select
                aria-label="실험 시나리오"
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
              >
                <option value="normal">일반 로그인 · 보호 API</option>
                <option value="short">단축 만료 · 10초 / 30초 / 60초</option>
                <option value="restore">로그인 유지로 새 세션 복원</option>
                <option value="shared">서버 B로 요청 전환</option>
                <option value="redis">Redis 연결 장애</option>
                <option value="db">DB 연결 장애</option>
                <option value="restart">실제 Redis 재시작 · 세션 소실</option>
                <option value="node">서버 A 재시작</option>
                <option value="prepared">
                  Redis 저장 후 DB 활성화 전 실패
                </option>
                <option value="cleanup">DB 폐기 후 Redis 정리 실패</option>
              </select>
            </label>
            <div className="experiment-buttons">
              <button
                className="secondary"
                disabled={labBusy || busy}
                onClick={experiment}
              >
                선택한 상황 적용
              </button>
              <button
                className="secondary"
                disabled={labBusy || busy}
                onClick={recover}
              >
                연결·처리 지점 장애 해제
              </button>
            </div>
            <label className="drop-control">
              <input
                type="checkbox"
                aria-label="다음 인증 변경 응답 유실"
                checked={dropNext}
                onChange={(e) => {
                  setDropNext(e.target.checked);
                  drop.current = e.target.checked;
                }}
              />
              다음 로그인·복원·로그아웃 응답 유실
            </label>
            <small>
              로컬 전용 제어 · 연결 장애는 현재 로컬 실습 서버 경로에
              적용됩니다.
            </small>
          </div>
          <div className="verification">
            <p className="eyebrow">BROWSER VERIFICATION</p>
            <div className="verification-title">
              <h2>데이터까지 확인하는 검증.</h2>
              <span className={results.status === "passed" ? "passed" : ""}>
                {results.status === "passed"
                  ? "통과"
                  : results.status === "running"
                    ? "실행 중"
                    : results.status === "failed"
                      ? "실패"
                      : "검증 대기"}
              </span>
            </div>
            <p>실제 HTTPS 요청 · PostgreSQL · Redis · 분리된 브라우저</p>
            <div className="verification-count">
              <strong>
                {results.tests?.filter((t: any) => t.status === "passed")
                  .length || 0}
              </strong>
              <span>
                / {results.tests?.length || 40}
                <small>최근 실행 시나리오</small>
              </span>
            </div>
            <div className="test-ids">
              {results.tests?.map((t: any) => (
                <span
                  key={t.id}
                  className={t.status === "passed" ? "pass" : "fail"}
                  title={t.title + " · " + t.status}
                >
                  {t.id}
                </span>
              ))}
            </div>
            <button
              className="primary"
              disabled={labBusy || results.status === "running"}
              onClick={runTests}
            >
              브라우저 전체 검증 실행<span>↗</span>
            </button>
            <small>장애 테스트 중 로컬 연결 상태가 일시적으로 바뀝니다.</small>
          </div>
        </section>
        <section id="record" className="history">
          <div className="section-title">
            <div>
              <p className="eyebrow">REQUEST JOURNAL</p>
              <h2>실행이 남긴 기록</h2>
            </div>
            <span>{traces.length} REQUESTS</span>
          </div>
          {traces.length === 0 ? (
            <p className="empty">
              첫 요청을 실행하면 실제 HTTP 결과와 처리 단계가 쌓입니다.
            </p>
          ) : (
            <div className="history-list">
              {traces.slice(0, 8).map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setSelected(t);
                    setStep(0);
                    setPlaying(true);
                    setTab("flow");
                  }}
                >
                  <span className={"http " + (t.status < 400 ? "ok" : "bad")}>
                    {(t as any).clientOutcome === "RESPONSE_LOST"
                      ? "미수신"
                      : t.status}
                  </span>
                  <b>{t.method}</b>
                  <span>{t.path}</span>
                  <small>서버 {t.instance}</small>
                  <code>{t.id.slice(0, 8)}</code>
                  <time>{when(t.startedAt)}</time>
                  <span>↗</span>
                </button>
              ))}
            </div>
          )}
        </section>
        {pending && (
          <div className="modal-backdrop">
            <section
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
            >
              <p className="eyebrow">VERIFY YOUR IDENTITY</p>
              <h2 id="confirm-title">비밀번호 재확인</h2>
              <p>기기를 관리하려면 비밀번호를 다시 확인해 주세요.</p>
              <form onSubmit={confirm}>
                <label>
                  재확인 비밀번호
                  <input
                    aria-label="재확인 비밀번호"
                    autoFocus
                    type="password"
                    autoComplete="current-password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </label>
                <p className="confirm-error">{confirmError}</p>
                <button className="primary" disabled={busy}>
                  확인하고 계속
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setPending(null);
                    setConfirmPassword("");
                  }}
                >
                  취소
                </button>
              </form>
            </section>
          </div>
        )}
        <footer>
          <strong>SESSION LAB</strong>
          <span>실제 요청 · 실행 기록 · 데이터 검증</span>
          <small>독립 로컬 실습 프로젝트</small>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
