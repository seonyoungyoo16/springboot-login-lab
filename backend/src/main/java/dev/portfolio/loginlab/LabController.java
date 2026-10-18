package dev.portfolio.loginlab;

import jakarta.servlet.http.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/lab")
public class LabController {
  private final Database db;
  private final RunStore runs;
  private final SessionStore store;
  private final TraceLog trace;
  private final boolean enabled;
  private final String key;
  private final Faults faults;

  public LabController(
      Database db,
      RunStore runs,
      SessionStore store,
      TraceLog trace,
      Faults faults,
      @Value("${lab.enabled}") boolean enabled,
      @Value("${lab.key}") String key) {
    this.db = db;
    this.runs = runs;
    this.store = store;
    this.trace = trace;
    this.faults = faults;
    this.enabled = enabled;
    this.key = key;
  }

  void check(HttpServletRequest req) {
    String sent = req.getHeader("X-Lab-Key");
    if (!enabled
        || sent == null
        || !MessageDigest.isEqual(
            key.getBytes(StandardCharsets.UTF_8), sent.getBytes(StandardCharsets.UTF_8)))
      throw new Failure(403, "LAB_DISABLED", "실습 제어에 접근할 수 없습니다.");
  }

  @PostMapping("/runs")
  public Map<String, Object> create(HttpServletRequest r, @RequestBody Map<String, String> b) {
    check(r);
    runs.create(b.getOrDefault("run", "studio"), b.getOrDefault("policy", "normal"));
    return Map.of(
        "run",
        b.getOrDefault("run", "studio"),
        "policy",
        runs.policy(b.getOrDefault("run", "studio")));
  }

  @GetMapping("/traces")
  public Object traces(HttpServletRequest r, @RequestParam(defaultValue = "studio") String run) {
    check(r);
    return trace.list(run);
  }

  @PostMapping("/fault")
  public Object fault(HttpServletRequest r, @RequestBody Map<String, String> body) {
    check(r);
    faults.configure(body.get("run"), body.get("point"), body.get("mode"));
    return Map.of("configured", true);
  }

  @GetMapping("/fault")
  public Object faultStatus(
      HttpServletRequest r, @RequestParam(defaultValue = "studio") String run) {
    check(r);
    return faults.status(run);
  }

  @PostMapping("/clear-sessions")
  public Object clear(HttpServletRequest r, @RequestBody Map<String, String> body) {
    check(r);
    var rows =
        db.sql.queryForList(
            "SELECT s.id FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE u.run_id=?",
            body.get("run"));
    int deleted = 0;
    for (var row : rows) {
      String sid = store.locate(row.get("id").toString());
      if (sid != null) {
        store.delete(sid);
        deleted++;
      }
    }
    return Map.of("deleted", deleted);
  }

  @PostMapping("/user-state")
  public Object userState(HttpServletRequest r, @RequestBody Map<String, String> body) {
    check(r);
    String login = body.getOrDefault("loginId", "demo@lab.test");
    db.tx.executeWithoutResult(
        t -> {
          var u =
              db.one(
                  "SELECT id FROM users WHERE run_id=? AND login_id=? FOR UPDATE",
                  body.get("run"),
                  login);
          if (u == null) throw new Failure(404, "USER_NOT_FOUND", "실습 계정 없음");
          if ("disable".equals(body.get("action")))
            db.sql.update("UPDATE users SET status='DISABLED' WHERE id=?", u.get("id"));
          else
            db.sql.update("UPDATE users SET auth_version=auth_version+1 WHERE id=?", u.get("id"));
        });
    return Map.of("updated", true);
  }

  @GetMapping("/snapshot")
  public Object snapshot(HttpServletRequest r, @RequestParam(defaultValue = "studio") String run) {
    check(r);
    var out = new LinkedHashMap<String, Object>();
    out.put("observedAt", Instant.now());
    out.put("run", run);
    List<Map<String, Object>> sessions = List.of();
    try {
      out.put("db", "available");
      out.put("policy", runs.policy(run));
      out.put(
          "users",
          db.sql.queryForList(
              "SELECT id,login_id,status,auth_version FROM users WHERE run_id=?", run));
      out.put(
          "grants",
          db.sql.queryForList(
              "SELECT g.id,g.label,g.mode,g.issued_at,g.expires_at,g.revoked_at,g.auth_version FROM device_auth_grants g JOIN users u ON u.id=g.user_id WHERE u.run_id=? ORDER BY g.issued_at DESC",
              run));
      sessions =
          db.sql.queryForList(
              "SELECT s.id,s.grant_id,s.state,s.created_at,s.absolute_expires_at FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE u.run_id=? ORDER BY s.created_at DESC",
              run);
      out.put("sessions", sessions);
      out.put(
          "remember",
          db.sql.queryForList(
              "SELECT c.grant_id,c.generation,c.expires_at,(c.previous_hash IS NOT NULL) AS has_previous FROM remember_credentials c JOIN device_auth_grants g ON g.id=c.grant_id JOIN users u ON u.id=g.user_id WHERE u.run_id=?",
              run));
      out.put(
          "preferences",
          db.sql.queryForList(
              "SELECT u.login_id,p.notifications,p.version FROM user_preferences p JOIN users u ON u.id=p.user_id WHERE u.run_id=?",
              run));
      out.put(
          "cleanup",
          db.sql.queryForList(
              "SELECT c.state,c.reason,c.attempts FROM auth_cleanup_tasks c JOIN auth_sessions s ON s.id=c.session_record_id JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE u.run_id=?",
              run));
    } catch (Exception e) {
      out.keySet().removeIf(k -> !Set.of("observedAt", "run").contains(k));
      out.put("db", "unavailable");
      sessions = List.of();
    }
    var redis = new ArrayList<Map<String, Object>>();
    try {
      store.ping();
      for (var s : sessions) {
        String sid = store.locate(s.get("id").toString());
        var row = new LinkedHashMap<String, Object>();
        row.put("sessionRecordId", s.get("id"));
        row.put("exists", sid != null && store.byId(sid) != null);
        if (sid != null) {
          var session = store.byId(sid);
          if (session != null) {
            row.put("lastAccessedAt", session.getLastAccessedTime());
            row.put(
                "idleExpiresAt",
                session.getLastAccessedTime().plus(session.getMaxInactiveInterval()));
            row.put("ttlSeconds", store.redis.getExpire("loginlab:sessions:" + sid));
          }
        }
        redis.add(row);
      }
      out.put("redis", "available");
      if ("available".equals(out.get("db"))) out.put("redisSessions", redis);
    } catch (Exception e) {
      out.put("redis", "unavailable");
    }
    return out;
  }
}
