package dev.portfolio.loginlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.*;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.*;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.csrf.*;
import org.springframework.session.Session;
import org.springframework.web.filter.OncePerRequestFilter;

@Configuration
public class SecurityConfig {
  @Bean
  PasswordEncoder encoder() {
    return new BCryptPasswordEncoder(10);
  }

  @Bean
  SecurityFilterChain security(
      HttpSecurity http, SessionStore store, TraceLog trace, AuthService auth, ObjectMapper json)
      throws Exception {
    CsrfTokenRepository csrf =
        new CsrfTokenRepository() {
          public CsrfToken generateToken(HttpServletRequest r) {
            return new DefaultCsrfToken("X-CSRF-TOKEN", "_csrf", AuthService.random());
          }

          public CsrfToken loadToken(HttpServletRequest r) {
            Session s = store.raw(r);
            String v = s == null ? null : s.getAttribute("csrf");
            return v == null ? null : new DefaultCsrfToken("X-CSRF-TOKEN", "_csrf", v);
          }

          // flow:SecurityConfig.csrf
          public void saveToken(CsrfToken token, HttpServletRequest r, HttpServletResponse res) {
            Session s = token == null ? store.raw(r) : store.csrfSession(r, res);
            if (s == null) return;
            if (token == null) s.removeAttribute("csrf");
            else s.setAttribute("csrf", token.getToken());
            store.save(s);
          }
        };
    http.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(
            c ->
                c.csrfTokenRepository(csrf)
                    .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler())
                    .ignoringRequestMatchers("/internal/**"))
        .requestCache(c -> c.disable())
        .formLogin(c -> c.disable())
        .httpBasic(c -> c.disable())
        .logout(c -> c.disable())
        .authorizeHttpRequests(
            a ->
                a.requestMatchers(
                        "/health",
                        "/internal/**",
                        "/api/auth/csrf",
                        "/api/auth/login",
                        "/api/auth/restore",
                        "/api/auth/logout")
                    .permitAll()
                    .anyRequest()
                    .authenticated())
        .exceptionHandling(
            e ->
                e.authenticationEntryPoint(
                        (r, s, x) -> error(s, json, 401, "SESSION_REQUIRED", "로그인이 필요합니다."))
                    .accessDeniedHandler(
                        (r, s, x) -> {
                          trace.step(
                              "Server",
                              "csrf_rejected",
                              "요청 검증 실패로 동작을 실행하지 않음",
                              "SecurityConfig.csrf");
                          error(s, json, 403, "CSRF_INVALID", "요청 확인 정보가 올바르지 않습니다.");
                        }))
        .addFilterBefore(
            new OncePerRequestFilter() {
              protected boolean shouldNotFilter(HttpServletRequest r) {
                String p = r.getRequestURI();
                return !p.startsWith("/api/")
                    || Set.of("/api/auth/csrf", "/api/auth/login", "/api/auth/restore").contains(p);
              }

              protected void doFilterInternal(
                  HttpServletRequest r, HttpServletResponse s, jakarta.servlet.FilterChain chain)
                  throws jakarta.servlet.ServletException, IOException {
                if (r.getRequestURI().equals("/api/auth/logout")
                    && (store.raw(r) == null || store.raw(r).getAttribute("user") == null)) {
                  chain.doFilter(r, s);
                  return;
                }
                var principal = auth.authenticate(r);
                r.setAttribute("principal", principal);
                var token =
                    org.springframework.security.authentication.UsernamePasswordAuthenticationToken
                        .authenticated(
                            principal,
                            null,
                            List.of(
                                new org.springframework.security.core.authority
                                    .SimpleGrantedAuthority("USER")));
                org.springframework.security.core.context.SecurityContextHolder.getContext()
                    .setAuthentication(token);
                chain.doFilter(r, s);
              }
            },
            AuthorizationFilter.class);
    return http.build();
  }

  static void error(
      HttpServletResponse s, ObjectMapper json, int status, String code, String message)
      throws IOException {
    s.setStatus(status);
    s.setContentType("application/json;charset=UTF-8");
    json.writeValue(s.getOutputStream(), Map.of("code", code, "message", message));
  }
}
