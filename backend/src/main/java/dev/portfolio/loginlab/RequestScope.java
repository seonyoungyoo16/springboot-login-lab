package dev.portfolio.loginlab;

import jakarta.servlet.http.HttpServletRequest;

public final class RequestScope {
  public static String run(HttpServletRequest r) {
    String v = r.getHeader("X-Lab-Run");
    return v != null && v.matches("[A-Za-z0-9_-]{1,80}") ? v : "studio";
  }
}
