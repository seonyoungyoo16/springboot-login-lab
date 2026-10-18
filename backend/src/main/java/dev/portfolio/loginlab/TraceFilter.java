package dev.portfolio.loginlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 5)
public class TraceFilter extends OncePerRequestFilter {
  private final TraceLog trace;
  private final ObjectMapper json;
  private final String instance;

  public TraceFilter(TraceLog trace, ObjectMapper json, @Value("${lab.instance}") String instance) {
    this.trace = trace;
    this.json = json;
    this.instance = instance;
  }

  protected boolean shouldNotFilter(HttpServletRequest r) {
    return !r.getRequestURI().startsWith("/api/");
  }

  // flow:TraceFilter.request
  protected void doFilterInternal(HttpServletRequest r, HttpServletResponse s, FilterChain chain)
      throws ServletException, IOException {
    String id = r.getHeader("X-Request-Id");
    if (id == null || !id.matches("[A-Za-z0-9-]{1,80}")) id = UUID.randomUUID().toString();
    s.setHeader("X-Request-Id", id);
    s.setHeader("X-App-Instance", instance);
    s.setHeader("Cache-Control", "no-store");
    trace.begin(RequestScope.run(r), r.getMethod(), r.getRequestURI(), id);
    // flow:TraceFilter.response
    try {
      chain.doFilter(r, s);
    } catch (Exception error) {
      Throwable e = error;
      while (e.getCause() != null && !(e instanceof Failure)) e = e.getCause();
      Failure f = e instanceof Failure ? (Failure) e : Failure.unavailable();
      trace.step("Server", "rejected", f.code, "TraceFilter.response");
      if (!s.isCommitted()) {
        s.setStatus(f.status);
        s.setContentType("application/json;charset=UTF-8");
        if (f.status == 429)
          s.setHeader(
              "Retry-After",
              r.getAttribute("retryAfter") == null
                  ? "60"
                  : r.getAttribute("retryAfter").toString());
        json.writeValue(
            s.getOutputStream(),
            Map.of("code", f.code, "message", f.getMessage(), "requestId", id));
      }
    } finally {
      trace.finish(s.getStatus());
    }
  }
}
