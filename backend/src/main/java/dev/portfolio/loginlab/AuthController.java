package dev.portfolio.loginlab;

import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

@RestController
public class AuthController {
  private final AuthService auth;
  private final AuthOperations operations;
  private final SessionStore sessions;

  public AuthController(AuthService auth, AuthOperations operations, SessionStore sessions) {
    this.auth = auth;
    this.operations = operations;
    this.sessions = sessions;
  }

  @GetMapping("/health")
  public Map<String, Object> health() {
    return Map.of("status", "up");
  }

  @GetMapping("/api/auth/csrf")
  public Map<String, Object> csrf(CsrfToken token) {
    return Map.of("token", token.getToken(), "headerName", token.getHeaderName());
  }

  @PostMapping("/api/auth/login")
  public Map<String, Object> login(
      HttpServletRequest r, HttpServletResponse s, @RequestBody AuthService.Login b) {
    return auth.login(r, s, b);
  }

  @PostMapping("/api/auth/restore")
  public Map<String, Object> restore(HttpServletRequest r, HttpServletResponse s) {
    return auth.restore(r, s);
  }

  @GetMapping("/api/auth/devices")
  public Object devices(HttpServletRequest r) {
    return operations.devices(principal(r));
  }

  @PostMapping("/api/auth/reauthenticate")
  @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
  public void reauthenticate(
      HttpServletRequest r, HttpServletResponse s, @RequestBody Map<String, String> body) {
    operations.reauthenticate(principal(r), body.get("password"), r, s);
  }

  @PostMapping("/api/auth/logout")
  @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
  public void logout(HttpServletRequest r, HttpServletResponse s) {
    var p = principal(r);
    if (p == null) operations.logoutWithoutSession(r, s);
    else operations.revoke(p, p.grantId(), false, s);
  }

  @PostMapping("/api/auth/logout-all")
  @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
  public void all(HttpServletRequest r, HttpServletResponse s) {
    var p = principal(r);
    operations.revoke(p, p.grantId(), true, s);
  }

  @DeleteMapping("/api/auth/devices/{id}")
  @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
  public void device(HttpServletRequest r, HttpServletResponse s, @PathVariable UUID id) {
    operations.revoke(principal(r), id, false, s);
  }

  @GetMapping("/api/auth/me")
  public Map<String, Object> me(HttpServletRequest r) {
    return auth.view(principal(r));
  }

  @GetMapping("/api/protected/report")
  public Map<String, Object> report(HttpServletRequest r) {
    return Map.of(
        "message",
        "실제 서버의 보호된 데이터입니다.",
        "auth",
        auth.view(principal(r)),
        "preferences",
        auth.preferences(principal(r)));
  }

  @PatchMapping("/api/protected/preferences")
  public Map<String, Object> preferences(
      HttpServletRequest r, @RequestBody Map<String, Boolean> b) {
    if (!b.containsKey("notifications") || b.get("notifications") == null)
      throw new Failure(400, "INVALID_REQUEST", "설정 값을 확인해 주세요.");
    return auth.updatePreferences(principal(r), b.get("notifications"));
  }

  static AuthService.Principal principal(HttpServletRequest r) {
    return (AuthService.Principal) r.getAttribute("principal");
  }
}
