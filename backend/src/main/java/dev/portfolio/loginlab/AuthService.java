package dev.portfolio.loginlab;

import static dev.portfolio.loginlab.Database.*;

import jakarta.servlet.http.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.session.Session;
import org.springframework.stereotype.Service;

@Service
public class AuthService {
  public record Principal(
      UUID userId,
      UUID grantId,
      UUID recordId,
      long version,
      Session session,
      Policy policy,
      String run) {}

  public record Login(String loginId, String password, boolean rememberMe, String deviceName) {}

  private final Database db;
  private final SessionStore sessions;
  private final RunStore runs;
  private final PasswordEncoder encoder;
  private final TraceLog trace;
  private final String instance, dummyHash;
  private final Faults faults;
  private final LoginLimiter limiter;

  public AuthService(
      Database db,
      SessionStore sessions,
      RunStore runs,
      PasswordEncoder encoder,
      TraceLog trace,
      Faults faults,
      LoginLimiter limiter,
      @Value("${lab.instance}") String instance) {
    this.db = db;
    this.sessions = sessions;
    this.runs = runs;
    this.encoder = encoder;
    this.trace = trace;
    this.faults = faults;
    this.limiter = limiter;
    this.instance = instance;
    this.dummyHash = encoder.encode(random());
  }

  public static String random() {
    byte[] b = new byte[32];
    new SecureRandom().nextBytes(b);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  public static String hash(String text) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  LoginLimiter.Permit limit(HttpServletRequest req, String login, Policy p) {
    return limiter.reserve(req, login, p);
  }

  // flow:AuthService.password
  public Map<String, Object> login(HttpServletRequest req, HttpServletResponse res, Login body) {
    String run = RequestScope.run(req);
    Policy p = runs.policy(run);
    String login = body.loginId() == null ? "" : body.loginId().trim().toLowerCase(Locale.ROOT);
    if (login.length() > 120 || body.password() == null || body.password().length() > 200)
      throw new Failure(400, "INVALID_REQUEST", "입력 값을 확인해 주세요.");
    Map<String, Object> user;
    boolean matches;
    try (var permit = limit(req, login, p)) {
      user = db.one("SELECT * FROM users WHERE run_id=? AND login_id=?", run, login);
      matches =
          encoder.matches(
              body.password(), user == null ? dummyHash : user.get("password_hash").toString());
      permit.finish(user != null && matches && "ACTIVE".equals(user.get("status")));
    }
    trace.step("Server", "password_checked", "비밀번호 단방향 해시 검증 완료", "AuthService.password");
    if (user == null || !matches || !"ACTIVE".equals(user.get("status"))) {
      throw new Failure(401, "AUTHENTICATION_FAILED", "아이디 또는 비밀번호를 확인해 주세요.");
    }
    Instant now = Instant.now();
    UUID uid = uuid(user, "id"), gid = UUID.randomUUID(), rid = UUID.randomUUID();
    long version = number(user, "auth_version");
    Session session = sessions.create(run);
    Instant grantEnd = now.plusSeconds(body.rememberMe() ? p.remember() : p.absolute());
    Instant absolute = min(now.plusSeconds(p.absolute()), grantEnd);
    String selector = body.rememberMe() ? random() : null,
        secret = body.rememberMe() ? random() : null;
    setAttributes(session, uid, gid, rid, version, "PASSWORD", now, absolute);
    String label =
        body.deviceName() == null || body.deviceName().isBlank()
            ? "현재 브라우저"
            : body.deviceName().trim();
    if (label.length() > 60) label = label.substring(0, 60);
    String name = label;
    // flow:AuthService.prepare
    db.tx.executeWithoutResult(
        t -> {
          Map<String, Object> latest = db.one("SELECT * FROM users WHERE id=? FOR UPDATE", uid);
          if (!"ACTIVE".equals(latest.get("status")) || number(latest, "auth_version") != version)
            throw new Failure(401, "AUTH_REVOKED", "인증 상태가 변경되었습니다.");
          db.sql.update(
              "INSERT INTO device_auth_grants(id,user_id,mode,label,issued_at,expires_at,auth_version) VALUES(?,?,?,?,?,?,?)",
              gid,
              uid,
              body.rememberMe() ? "REMEMBER" : "SESSION",
              name,
              stamp(now),
              stamp(grantEnd),
              version);
          insertPreparing(rid, gid, session, version, now, absolute, p);
          if (body.rememberMe())
            db.sql.update(
                "INSERT INTO remember_credentials(selector,grant_id,current_hash,expires_at) VALUES(?,?,?,?)",
                selector,
                gid,
                hash(secret),
                stamp(grantEnd));
        });
    trace.step("DB", "prepared", "기기 인증과 PREPARING 세션 커밋", "AuthService.prepare");
    sessions.saveAuthenticated(session, p);
    faults.check(run, "after-redis-save");
    faults.check(run, "before-activate");
    activate(uid, gid, rid, version);
    var result = view(new Principal(uid, gid, rid, version, session, p, run));
    sessions.setCookie(res, SessionStore.COOKIE, session.getId(), null);
    if (body.rememberMe())
      sessions.setCookie(
          res,
          SessionStore.REMEMBER,
          selector + "." + secret,
          Math.max(1, Duration.between(Instant.now(), grantEnd).getSeconds()));
    else sessions.setCookie(res, SessionStore.REMEMBER, "", 0L);
    req.setAttribute("lab.session", session);
    audit(run, "LOGIN", "SUCCESS");
    return result;
  }

  void setAttributes(
      Session s,
      UUID uid,
      UUID gid,
      UUID rid,
      long version,
      String method,
      Instant passwordAt,
      Instant absolute) {
    s.setAttribute("user", uid.toString());
    s.setAttribute("grant", gid.toString());
    s.setAttribute("record", rid.toString());
    s.setAttribute("version", version);
    s.setAttribute("method", method);
    s.setAttribute("passwordAt", passwordAt == null ? 0L : passwordAt.toEpochMilli());
    s.setAttribute("absolute", absolute.toEpochMilli());
  }

  void insertPreparing(
      UUID rid, UUID gid, Session s, long version, Instant now, Instant absolute, Policy p) {
    db.sql.update(
        "INSERT INTO auth_sessions(id,grant_id,sid_hash,state,created_at,absolute_expires_at,auth_version,preparing_expires_at) VALUES(?,?,?,'PREPARING',?,?,?,?)",
        rid,
        gid,
        hash(s.getId()),
        stamp(now),
        stamp(absolute),
        version,
        stamp(now.plusSeconds(p.preparing())));
  }

  // flow:AuthService.activate
  void activate(UUID uid, UUID gid, UUID rid, long version) {
    activate(uid, gid, rid, version, null);
  }

  void activate(UUID uid, UUID gid, UUID rid, long version, UUID previous) {
    db.tx.executeWithoutResult(
        t -> {
          Map<String, Object> user = db.one("SELECT * FROM users WHERE id=? FOR UPDATE", uid),
              g = db.one("SELECT * FROM device_auth_grants WHERE id=? FOR UPDATE", gid),
              s = db.one("SELECT * FROM auth_sessions WHERE id=? FOR UPDATE", rid);
          Instant now = Instant.now();
          if (user == null
              || g == null
              || s == null
              || !"ACTIVE".equals(user.get("status"))
              || number(user, "auth_version") != version
              || g.get("revoked_at") != null
              || !time(g, "expires_at").isAfter(now)
              || !"PREPARING".equals(s.get("state"))
              || !time(s, "preparing_expires_at").isAfter(now)
              || !time(s, "absolute_expires_at").isAfter(now))
            throw new Failure(401, "AUTH_REVOKED", "인증 발급을 완료할 수 없습니다.");
          db.sql.update("UPDATE auth_sessions SET state='ACTIVE' WHERE id=?", rid);
          if (previous != null) {
            db.sql.update("UPDATE auth_sessions SET state='REVOKED' WHERE id=?", previous);
            db.sql.update(
                "INSERT INTO auth_cleanup_tasks(id,session_record_id,reason) VALUES(?,?,'REAUTHENTICATED') ON CONFLICT(session_record_id) DO NOTHING",
                UUID.randomUUID(),
                previous);
          }
          db.sql.update(
              "INSERT INTO auth_audit_events(id,run_id,request_id,instance,event,outcome) VALUES(?,?,?,?,?,'COMMITTED')",
              UUID.randomUUID(),
              user.get("run_id"),
              trace.id(),
              instance,
              "SESSION_ACTIVATED");
        });
    trace.step("DB", "activated", "폐기·버전 재확인 후 ACTIVE 커밋", "AuthService.activate");
  }

  // flow:AuthService.guard
  public Principal authenticate(HttpServletRequest req) {
    Session s = sessions.raw(req);
    trace.step(
        "Redis", "session_lookup", s == null ? "현재 세션 없음" : "공유 저장소에서 세션 조회", "AuthService.guard");
    if (s == null || s.getAttribute("user") == null)
      throw new Failure(401, "SESSION_REQUIRED", "로그인이 필요합니다.");
    Long absolute = s.getAttribute("absolute");
    if (absolute == null || absolute <= System.currentTimeMillis())
      throw new Failure(401, "SESSION_EXPIRED", "로그인 시간이 만료되었습니다.");
    String run = RequestScope.run(req);
    Map<String, Object> row =
        db.one(
            "SELECT s.state,s.sid_hash,s.auth_version AS session_version,s.absolute_expires_at,g.id AS grant_id,g.revoked_at,g.expires_at,g.auth_version AS grant_version,u.id AS user_id,u.status,u.auth_version FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE s.id=? AND u.run_id=?",
            UUID.fromString(s.getAttribute("record")),
            run);
    validate(row, s.getId());
    trace.step("DB", "validity_checked", "세션 활성·기기 폐기·사용자 버전 검증", "AuthService.guard");
    Policy p = runs.policy(run);
    sessions.saveAuthenticated(s, p);
    return new Principal(
        uuid(row, "user_id"),
        uuid(row, "grant_id"),
        UUID.fromString(s.getAttribute("record")),
        number(row, "auth_version"),
        s,
        p,
        run);
  }

  void validate(Map<String, Object> r, String sid) {
    Instant now = Instant.now();
    if (r == null
        || !"ACTIVE".equals(r.get("state"))
        || !"ACTIVE".equals(r.get("status"))
        || !hash(sid).equals(r.get("sid_hash"))
        || r.get("revoked_at") != null
        || number(r, "session_version") != number(r, "auth_version")
        || number(r, "grant_version") != number(r, "auth_version"))
      throw new Failure(401, "AUTH_REVOKED", "로그인 권한이 해제되었습니다.");
    if (!time(r, "expires_at").isAfter(now) || !time(r, "absolute_expires_at").isAfter(now))
      throw new Failure(401, "SESSION_EXPIRED", "로그인 시간이 만료되었습니다.");
  }

  public Map<String, Object> view(Principal p) {
    Map<String, Object> u = db.one("SELECT login_id FROM users WHERE id=?", p.userId());
    Instant absolute = Instant.ofEpochMilli(p.session().getAttribute("absolute"));
    var m = new LinkedHashMap<String, Object>();
    m.put("loginId", u.get("login_id"));
    m.put("grantId", p.grantId());
    m.put("sessionRecordId", p.recordId());
    m.put("method", p.session().getAttribute("method"));
    m.put(
        "idleExpiresAt",
        p.session().getLastAccessedTime().plus(p.session().getMaxInactiveInterval()));
    m.put("absoluteExpiresAt", absolute);
    m.put("passwordVerifiedAt", p.session().getAttribute("passwordAt"));
    m.put("instance", instance);
    m.put("requestId", trace.id());
    var credential =
        db.one(
            "SELECT expires_at,generation FROM remember_credentials WHERE grant_id=?", p.grantId());
    if (credential != null) {
      m.put("rememberExpiresAt", time(credential, "expires_at"));
      m.put("generation", number(credential, "generation"));
    }
    return m;
  }

  public Map<String, Object> preferences(Principal p) {
    return db.one("SELECT notifications,version FROM user_preferences WHERE user_id=?", p.userId());
  }

  // flow:AuthService.write
  public Map<String, Object> updatePreferences(Principal p, boolean value) {
    var result =
        db.tx.execute(
            t -> {
              db.one("SELECT id FROM users WHERE id=? FOR UPDATE", p.userId());
              db.one("SELECT id FROM device_auth_grants WHERE id=? FOR UPDATE", p.grantId());
              Map<String, Object> r =
                  db.one(
                      "SELECT s.state,s.sid_hash,s.auth_version AS session_version,s.absolute_expires_at,g.revoked_at,g.expires_at,g.auth_version AS grant_version,u.status,u.auth_version FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE s.id=?",
                      p.recordId());
              validate(r, p.session().getId());
              db.sql.update(
                  "UPDATE user_preferences SET notifications=?,version=version+1,updated_at=now() WHERE user_id=?",
                  value,
                  p.userId());
              return preferences(p);
            });
    trace.step("DB", "preferences_committed", "보호된 설정 변경과 version 증가 커밋", "AuthService.write");
    return result;
  }

  static Instant min(Instant a, Instant b) {
    return a.isBefore(b) ? a : b;
  }

  // flow:AuthService.restore
  public Map<String, Object> restore(HttpServletRequest req, HttpServletResponse res) {
    String value = SessionStore.cookie(req, SessionStore.REMEMBER);
    if (value == null || !value.matches("[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}"))
      throw new Failure(401, "REMEMBER_INVALID", "로그인이 필요합니다.");
    String[] parts = value.split("\\.", 2);
    String run = RequestScope.run(req);
    Policy p = runs.policy(run);
    Map<String, Object> first =
        db.one(
            "SELECT g.id AS grant_id,g.user_id FROM remember_credentials c JOIN device_auth_grants g ON g.id=c.grant_id JOIN users u ON u.id=g.user_id WHERE c.selector=? AND u.run_id=?",
            parts[0],
            run);
    if (first == null) throw new Failure(401, "REMEMBER_INVALID", "로그인 유지 정보가 유효하지 않습니다.");
    UUID uid = uuid(first, "user_id"), gid = uuid(first, "grant_id"), rid = UUID.randomUUID();
    Session session = sessions.create(run);
    String next = random();
    Instant now = Instant.now();
    long version =
        db.tx.execute(
            t -> {
              Map<String, Object> u = db.one("SELECT * FROM users WHERE id=? FOR UPDATE", uid),
                  g = db.one("SELECT * FROM device_auth_grants WHERE id=? FOR UPDATE", gid),
                  c =
                      db.one(
                          "SELECT * FROM remember_credentials WHERE selector=? FOR UPDATE",
                          parts[0]);
              if (c == null || g == null)
                throw new Failure(401, "REMEMBER_INVALID", "로그인 유지 정보가 유효하지 않습니다.");
              if (!time(c, "expires_at").isAfter(Instant.now()))
                throw new Failure(401, "REMEMBER_EXPIRED", "로그인 유지 기간이 끝났습니다.");
              if (!"ACTIVE".equals(u.get("status"))
                  || g.get("revoked_at") != null
                  || number(g, "auth_version") != number(u, "auth_version"))
                throw new Failure(401, "AUTH_REVOKED", "로그인 권한이 해제되었습니다.");
              String sent = hash(parts[1]);
              if (!MessageDigest.isEqual(
                  sent.getBytes(StandardCharsets.UTF_8),
                  c.get("current_hash").toString().getBytes(StandardCharsets.UTF_8))) {
                if (c.get("previous_hash") != null
                    && sent.equals(c.get("previous_hash"))
                    && time(c, "previous_used_at").plusSeconds(p.grace()).isAfter(Instant.now()))
                  throw new Failure(
                      409, "RESTORE_ALREADY_PROCESSED", "다른 탭의 로그인 복원 결과를 확인하고 있습니다.");
                throw new Failure(401, "REMEMBER_STALE", "이미 사용했거나 유효하지 않은 로그인 유지 정보입니다.");
              }
              Instant end = min(now.plusSeconds(p.absolute()), time(c, "expires_at"));
              long v = number(u, "auth_version");
              setAttributes(session, uid, gid, rid, v, "REMEMBER", null, end);
              db.sql.update(
                  "UPDATE remember_credentials SET previous_hash=current_hash,current_hash=?,previous_used_at=?,generation=generation+1 WHERE selector=?",
                  hash(next),
                  stamp(Instant.now()),
                  parts[0]);
              insertPreparing(rid, gid, session, v, now, end, p);
              return v;
            });
    trace.step("DB", "remember_rotated", "잠금 후 최신 토큰 재검증·교체와 PREPARING 커밋", "AuthService.restore");
    sessions.saveAuthenticated(session, p);
    faults.check(run, "after-redis-save");
    faults.check(run, "before-activate");
    activate(uid, gid, rid, version);
    Instant expiry =
        time(
            db.one("SELECT expires_at FROM remember_credentials WHERE selector=?", parts[0]),
            "expires_at");
    var result = view(new Principal(uid, gid, rid, version, session, p, run));
    audit(run, "RESTORE", "SUCCESS");
    sessions.setCookie(res, SessionStore.COOKIE, session.getId(), null);
    sessions.setCookie(
        res,
        SessionStore.REMEMBER,
        parts[0] + "." + next,
        Math.max(1, Duration.between(Instant.now(), expiry).getSeconds()));
    req.setAttribute("lab.session", session);
    return result;
  }

  void audit(String run, String event, String result) {
    try {
      db.sql.update(
          "INSERT INTO auth_audit_events(id,run_id,request_id,instance,event,outcome) VALUES(?,?,?,?,?,?)",
          UUID.randomUUID(),
          run,
          trace.id(),
          instance,
          event,
          result);
    } catch (Exception ignored) {
    }
  }
}
