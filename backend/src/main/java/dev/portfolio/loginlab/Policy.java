package dev.portfolio.loginlab;

import java.time.Duration;

public record Policy(
    long idle,
    long absolute,
    long remember,
    long recent,
    long grace,
    long preparing,
    long failureWindow) {
  public static Policy of(String name) {
    return switch (name) {
      case "short" -> new Policy(10, 30, 60, 10, 2, 5, 5);
      case "expiry" -> new Policy(3, 9, 18, 3, 2, 5, 5);
      default -> new Policy(1800, 28800, 1209600, 300, 5, 30, 300);
    };
  }

  public Duration idleDuration() {
    return Duration.ofSeconds(idle);
  }
}
