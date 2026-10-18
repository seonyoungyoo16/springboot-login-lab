package dev.portfolio.loginlab;

import jakarta.servlet.http.HttpServletRequest;
import java.util.*;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

@Service
public class LoginLimiter {
  private final SessionStore sessions;
  private final TraceLog trace;

  public LoginLimiter(SessionStore sessions, TraceLog trace) {
    this.sessions = sessions;
    this.trace = trace;
  }

  public final class Permit implements AutoCloseable {
    private final String failed, pending;
    private final long window;
    private boolean completed;

    Permit(String failed, String pending, long window) {
      this.failed = failed;
      this.pending = pending;
      this.window = window;
    }

    public void finish(boolean success) {
      sessions.redis.execute(
          new DefaultRedisScript<>(
              "if ARGV[1]=='1' then redis.call('DEL',KEYS[1]); else local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[2]) end end; local p=redis.call('DECR',KEYS[2]); if p<=0 then redis.call('DEL',KEYS[2]) end; return 1",
              Long.class),
          List.of(failed, pending),
          success ? "1" : "0",
          String.valueOf(window));
      completed = true;
    }

    public void close() {
      if (!completed)
        try {
          sessions.redis.execute(
              new DefaultRedisScript<>(
                  "local p=redis.call('DECR',KEYS[1]); if p<=0 then redis.call('DEL',KEYS[1]) end; return 1",
                  Long.class),
              List.of(pending));
        } catch (Exception ignored) {
        }
    }
  }

  // flow:LoginLimiter.reserve
  public Permit reserve(HttpServletRequest req, String login, Policy policy) {
    String prefix = "loginlab:limit:" + RequestScope.run(req) + ":",
        ip = prefix + "ip:" + AuthService.hash(req.getRemoteAddr());
    Long count =
        sessions.redis.execute(
            new DefaultRedisScript<>(
                "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
                Long.class),
            List.of(ip));
    if (count != null && count > 20) {
      req.setAttribute("retryAfter", Math.max(1, sessions.redis.getExpire(ip)));
      throw new Failure(429, "RATE_LIMITED", "로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.");
    }
    String failed = prefix + "account:" + AuthService.hash(login), pending = failed + ":pending";
    Long allowed =
        sessions.redis.execute(
            new DefaultRedisScript<>(
                "local f=tonumber(redis.call('GET',KEYS[1]) or '0');local p=tonumber(redis.call('GET',KEYS[2]) or '0');if f+p>=5 then return 0 end;redis.call('INCR',KEYS[2]);redis.call('EXPIRE',KEYS[2],ARGV[1]);return 1",
                Long.class),
            List.of(failed, pending),
            String.valueOf(policy.failureWindow()));
    if (allowed == null || allowed == 0) {
      req.setAttribute("retryAfter", Math.max(1, sessions.redis.getExpire(failed)));
      throw new Failure(429, "RATE_LIMITED", "잠시 후 다시 시도해 주세요.");
    }
    trace.step("Redis", "rate_limit", "실패 횟수와 진행 중 검증을 원자적으로 확인", "LoginLimiter.reserve");
    return new Permit(failed, pending, policy.failureWindow());
  }
}
