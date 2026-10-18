package dev.portfolio.loginlab;

import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import org.springframework.context.annotation.*;
import org.springframework.data.redis.core.*;
import org.springframework.data.redis.serializer.*;
import org.springframework.http.ResponseCookie;
import org.springframework.session.*;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.stereotype.Service;

@Service
public class SessionStore {
  public static final String COOKIE = "__Host-auth_session", REMEMBER = "__Host-remember_me";
  private final SessionRepository<Session> repo;
  public final StringRedisTemplate redis;
  private final TraceLog trace;

  @SuppressWarnings("unchecked")
  public SessionStore(
      org.springframework.data.redis.connection.RedisConnectionFactory factory,
      StringRedisTemplate redis,
      TraceLog trace) {
    RedisTemplate<String, Object> template = new RedisTemplate<>();
    template.setConnectionFactory(factory);
    template.setKeySerializer(new StringRedisSerializer());
    template.setHashKeySerializer(new StringRedisSerializer());
    template.setValueSerializer(new JdkSerializationRedisSerializer());
    template.setHashValueSerializer(new JdkSerializationRedisSerializer());
    template.afterPropertiesSet();
    RedisSessionRepository real = new RedisSessionRepository(template);
    real.setRedisKeyNamespace("loginlab");
    real.setDefaultMaxInactiveInterval(Duration.ofMinutes(10));
    repo = (SessionRepository<Session>) (SessionRepository<?>) real;
    this.redis = redis;
    this.trace = trace;
  }

  public static String cookie(HttpServletRequest r, String name) {
    if (r.getCookies() != null)
      for (Cookie c : r.getCookies()) if (c.getName().equals(name)) return c.getValue();
    return null;
  }

  public Session raw(HttpServletRequest r) {
    Object cache = r.getAttribute("lab.session");
    if (cache instanceof Session s) return s;
    String id = cookie(r, COOKIE);
    if (id == null) {
      ping();
      return null;
    }
    Session s;
    try {
      s = repo.findById(id);
    } catch (IllegalStateException e) {
      try {
        repo.deleteById(id);
      } catch (Exception ignored) {
      }
      throw new Failure(401, "SESSION_INVALID", "세션 정보가 유효하지 않습니다.");
    }
    if (s != null) {
      if (!RequestScope.run(r).equals(s.getAttribute("run"))) return null;
      r.setAttribute("lab.session", s);
    }
    return s;
  }

  public void ping() {
    redis.execute((org.springframework.data.redis.core.RedisCallback<String>) c -> c.ping());
  }

  public Session create(String run) {
    Session s = repo.createSession();
    s.setAttribute("run", run);
    return s;
  }

  public void save(Session s) {
    repo.save(s);
  }

  public void delete(String sid) {
    repo.deleteById(sid);
  }

  public void rememberIndex(Session s) {
    String id = s.getAttribute("record");
    if (id != null)
      redis
          .opsForValue()
          .set(
              "loginlab:ref:" + id, s.getId(), Duration.ofSeconds(Math.max(30, remaining(s) + 30)));
  }

  public String locate(String record) {
    return redis.opsForValue().get("loginlab:ref:" + record);
  }

  public Session byId(String sid) {
    return repo.findById(sid);
  }

  public long remaining(Session s) {
    Long end = s.getAttribute("absolute");
    return end == null ? 600 : Math.max(0, (end - System.currentTimeMillis() + 999) / 1000);
  }

  public void saveAuthenticated(Session s, Policy p) {
    long remaining = remaining(s);
    if (remaining <= 0) throw new Failure(401, "SESSION_EXPIRED", "로그인 시간이 만료되었습니다.");
    s.setLastAccessedTime(Instant.now());
    s.setMaxInactiveInterval(Duration.ofSeconds(Math.min(p.idle(), remaining)));
    repo.save(s);
    rememberIndex(s);
    trace.step("Redis", "session_saved", "현재 세션 저장과 유휴 시간 반영", "SessionStore.save");
  }

  // flow:SessionStore.save
  public void setCookie(HttpServletResponse s, String name, String value, Long maxAge) {
    ResponseCookie.ResponseCookieBuilder b =
        ResponseCookie.from(name, value).path("/").httpOnly(true).secure(true).sameSite("Lax");
    if (maxAge != null) b.maxAge(maxAge);
    s.addHeader("Set-Cookie", b.build().toString());
  }

  public void clearCookies(HttpServletResponse s) {
    setCookie(s, COOKIE, "", 0L);
    setCookie(s, REMEMBER, "", 0L);
  }

  public Session csrfSession(HttpServletRequest r, HttpServletResponse response) {
    Session s = raw(r);
    if (s == null) {
      s = create(RequestScope.run(r));
      s.setMaxInactiveInterval(Duration.ofMinutes(10));
      r.setAttribute("lab.session", s);
      setCookie(response, COOKIE, s.getId(), null);
    }
    return s;
  }
}
