package dev.portfolio.loginlab;

import static dev.portfolio.loginlab.Database.*;

import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.session.Session;
import org.springframework.stereotype.Service;

@Service
public class AuthOperations {
  private final Database db;
  private final SessionStore sessions;
  private final AuthService auth;
  private final PasswordEncoder encoder;
  private final TraceLog trace;
  private final CleanupService cleanup;
  private final Faults faults;
  private final String instance;

  public AuthOperations(
      Database db,
      SessionStore sessions,
      AuthService auth,
      PasswordEncoder encoder,
      TraceLog trace,
      CleanupService cleanup,
      Faults faults,
      @org.springframework.beans.factory.annotation.Value("${lab.instance}") String instance) {
    this.db = db;
    this.sessions = sessions;
    this.auth = auth;
    this.encoder = encoder;
    this.trace = trace;
    this.cleanup = cleanup;
    this.faults = faults;
    this.instance = instance;
  }

  void recent(AuthService.Principal p) {
    Long at = p.session().getAttribute("passwordAt");
    if (at == null || at == 0 || at + p.policy().recent() * 1000 < System.currentTimeMillis())
      throw new Failure(403, "REAUTH_REQUIRED", "비밀번호를 다시 확인해 주세요.");
  }

  void lockedValidate(AuthService.Principal p) {
    db.one("SELECT id FROM users WHERE id=? FOR UPDATE", p.userId());
    db.one("SELECT id FROM device_auth_grants WHERE id=? FOR UPDATE", p.grantId());
    var r =
        db.one(
            "SELECT s.state,s.sid_hash,s.auth_version AS session_version,s.absolute_expires_at,g.revoked_at,g.expires_at,g.auth_version AS grant_version,u.status,u.auth_version FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE s.id=?",
            p.recordId());
    auth.validate(r, p.session().getId());
  }

  // flow:AuthOperations.reauthenticate
  public void reauthenticate(
      AuthService.Principal p, String password, HttpServletRequest req, HttpServletResponse res) {
    if (password == null || password.length() > 200)
      throw new Failure(401, "REAUTHENTICATION_FAILED", "비밀번호를 확인해 주세요.");
    var user = db.one("SELECT password_hash,login_id FROM users WHERE id=?", p.userId());
    String hash = user.get("password_hash").toString();
    boolean matches;
    try (var permit = auth.limit(req, user.get("login_id").toString(), p.policy())) {
      matches = encoder.matches(password, hash);
      permit.finish(matches);
    }
    if (!matches) throw new Failure(401, "REAUTHENTICATION_FAILED", "비밀번호를 확인해 주세요.");
    UUID rid = UUID.randomUUID();
    Instant now = Instant.now(),
        absolute = Instant.ofEpochMilli(p.session().getAttribute("absolute"));
    Session fresh = sessions.create(p.run());
    auth.setAttributes(fresh, p.userId(), p.grantId(), rid, p.version(), "PASSWORD", now, absolute);
    db.tx.executeWithoutResult(
        t -> {
          lockedValidate(p);
          auth.insertPreparing(rid, p.grantId(), fresh, p.version(), now, absolute, p.policy());
        });
    trace.step("DB", "reauth_prepared", "비밀번호 재확인 후 새 식별자 준비", "AuthOperations.reauthenticate");
    sessions.saveAuthenticated(fresh, p.policy());
    auth.activate(p.userId(), p.grantId(), rid, p.version(), p.recordId());
    sessions.setCookie(res, SessionStore.COOKIE, fresh.getId(), null);
    req.setAttribute("lab.session", fresh);
    trace.step(
        "Server", "reauthenticated", "기존 절대 수명을 유지하며 인증 수준 갱신", "AuthOperations.reauthenticate");
  }

  public List<Map<String, Object>> devices(AuthService.Principal p) {
    var list =
        db.sql.queryForList(
            "SELECT g.id,g.label,g.mode,g.issued_at,g.expires_at,g.revoked_at,g.auth_version,u.auth_version AS current_version FROM device_auth_grants g JOIN users u ON u.id=g.user_id WHERE g.user_id=? ORDER BY g.issued_at DESC",
            p.userId());
    for (var row : list) {
      row.put("current", row.get("id").equals(p.grantId()));
      row.put(
          "status",
          row.get("revoked_at") != null
                  || number(row, "auth_version") != number(row, "current_version")
              ? "REVOKED"
              : time(row, "expires_at").isBefore(Instant.now()) ? "EXPIRED" : "ACTIVE");
    }
    return list;
  }

  void queue(List<Map<String, Object>> records, String reason) {
    for (var r : records)
      db.sql.update(
          "INSERT INTO auth_cleanup_tasks(id,session_record_id,reason,next_attempt_at) VALUES(?,?,?,now()+interval '5 seconds') ON CONFLICT(session_record_id) DO NOTHING",
          UUID.randomUUID(),
          r.get("id"),
          reason);
  }

  void audit(AuthService.Principal p, String event) {
    audit(p.run(), event);
  }

  void audit(String run, String event) {
    db.sql.update(
        "INSERT INTO auth_audit_events(id,run_id,request_id,instance,event,outcome) VALUES(?,?,?,?,?,'COMMITTED')",
        UUID.randomUUID(),
        run,
        trace.id(),
        instance,
        event);
  }

  // flow:AuthOperations.expiredLogout
  public void logoutWithoutSession(HttpServletRequest req, HttpServletResponse res) {
    String value = SessionStore.cookie(req, SessionStore.REMEMBER), run = RequestScope.run(req);
    if (value == null || !value.matches("[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}")) {
      sessions.clearCookies(res);
      return;
    }
    String[] parts = value.split("\\.", 2);
    var first =
        db.one(
            "SELECT g.id,g.user_id FROM remember_credentials c JOIN device_auth_grants g ON g.id=c.grant_id JOIN users u ON u.id=g.user_id WHERE c.selector=? AND u.run_id=?",
            parts[0],
            run);
    if (first == null) {
      sessions.clearCookies(res);
      return;
    }
    var records =
        db.tx.execute(
            t -> {
              var user = db.one("SELECT * FROM users WHERE id=? FOR UPDATE", first.get("user_id"));
              var grant =
                  db.one("SELECT * FROM device_auth_grants WHERE id=? FOR UPDATE", first.get("id"));
              var credential =
                  db.one(
                      "SELECT * FROM remember_credentials WHERE selector=? FOR UPDATE", parts[0]);
              if (grant.get("revoked_at") != null
                  || !time(grant, "expires_at").isAfter(Instant.now())
                  || number(grant, "auth_version") != number(user, "auth_version")
                  || !"ACTIVE".equals(user.get("status"))) return List.<Map<String, Object>>of();
              String sent = AuthService.hash(parts[1]);
              if (!sent.equals(credential.get("current_hash"))
                  && !sent.equals(credential.get("previous_hash")))
                throw new Failure(401, "REMEMBER_STALE", "로그아웃 처리 상태를 확인할 수 없습니다. 다시 로그인해 주세요.");
              var list =
                  db.sql.queryForList(
                      "SELECT id FROM auth_sessions WHERE grant_id=?", first.get("id"));
              db.sql.update(
                  "UPDATE device_auth_grants SET revoked_at=now() WHERE id=?", first.get("id"));
              db.sql.update(
                  "UPDATE auth_sessions SET state='REVOKED' WHERE grant_id=?", first.get("id"));
              queue(list, "EXPIRED_SESSION_LOGOUT");
              audit(run, "EXPIRED_SESSION_LOGOUT");
              return list;
            });
    trace.step(
        "DB",
        "revocation_committed",
        "세션 만료 후에도 유지 자격정보를 검증하여 기기 인증 폐기",
        "AuthOperations.expiredLogout");
    for (var row : records.stream().limit(5).toList())
      try {
        cleanup.clean(UUID.fromString(row.get("id").toString()));
      } catch (Exception ignored) {
      }
    sessions.clearCookies(res);
  }

  // flow:AuthOperations.revoke
  public void revoke(AuthService.Principal p, UUID target, boolean all, HttpServletResponse res) {
    if (all || !target.equals(p.grantId())) recent(p);
    List<Map<String, Object>> records =
        db.tx.execute(
            t -> {
              lockedValidate(p);
              if (!all) {
                var g =
                    db.one(
                        "SELECT * FROM device_auth_grants WHERE id=? AND user_id=? FOR UPDATE",
                        target,
                        p.userId());
                if (g == null) throw new Failure(404, "DEVICE_NOT_FOUND", "기기를 찾을 수 없습니다.");
              }
              List<Map<String, Object>> list =
                  all
                      ? db.sql.queryForList(
                          "SELECT s.id FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id WHERE g.user_id=?",
                          p.userId())
                      : db.sql.queryForList(
                          "SELECT id FROM auth_sessions WHERE grant_id=?", target);
              if (all) {
                db.sql.update(
                    "UPDATE users SET auth_version=auth_version+1 WHERE id=?", p.userId());
                db.sql.update(
                    "UPDATE device_auth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=?",
                    p.userId());
                db.sql.update(
                    "UPDATE auth_sessions SET state='REVOKED' WHERE grant_id IN(SELECT id FROM device_auth_grants WHERE user_id=?)",
                    p.userId());
              } else {
                db.sql.update(
                    "UPDATE device_auth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE id=?",
                    target);
                db.sql.update("UPDATE auth_sessions SET state='REVOKED' WHERE grant_id=?", target);
              }
              queue(list, all ? "LOGOUT_ALL" : "DEVICE_REVOKED");
              audit(p, all ? "LOGOUT_ALL" : "DEVICE_REVOKED");
              faults.check(p.run(), "before-revoke-commit");
              return list;
            });
    trace.step("DB", "revocation_committed", "인증 폐기와 정리 작업을 같은 트랜잭션으로 커밋", "AuthOperations.revoke");
    try {
      faults.check(p.run(), "after-revoke-commit");
      for (var r : records.stream().limit(5).toList())
        cleanup.clean(UUID.fromString(r.get("id").toString()));
      trace.step("Redis", "session_cleaned", "폐기된 세션 정리 완료 또는 TTL 정리 대기", "CleanupService.clean");
    } catch (Exception e) {
      trace.step("Redis", "cleanup_deferred", "DB 폐기 완료 · Redis 정리는 재시도", "CleanupService.clean");
    }
    if (all || target.equals(p.grantId())) sessions.clearCookies(res);
  }
}
