package dev.portfolio.loginlab;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class ApiAdvice {
  private final TraceLog trace;

  public ApiAdvice(TraceLog trace) {
    this.trace = trace;
  }

  @ExceptionHandler(Failure.class)
  public ResponseEntity<?> failure(Failure f, jakarta.servlet.http.HttpServletRequest r) {
    trace.step("Server", "rejected", f.code, "TraceFilter.response");
    var b = ResponseEntity.status(f.status);
    if (f.status == 429)
      b.header(
          "Retry-After",
          r.getAttribute("retryAfter") == null ? "60" : r.getAttribute("retryAfter").toString());
    return b.body(Map.of("code", f.code, "message", f.getMessage(), "requestId", trace.id()));
  }

  @ExceptionHandler({
    org.springframework.dao.DataAccessException.class,
    org.springframework.data.redis.RedisConnectionFailureException.class
  })
  public ResponseEntity<?> dependency(Exception e) {
    trace.step("Server", "unavailable", "실제 저장소 접근 실패", "TraceFilter.response");
    return ResponseEntity.status(503)
        .body(
            Map.of(
                "code",
                "DEPENDENCY_UNAVAILABLE",
                "message",
                "서버 저장소에 연결할 수 없습니다.",
                "requestId",
                trace.id()));
  }
}
