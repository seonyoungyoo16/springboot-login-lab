package dev.portfolio.loginlab;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.springframework.stereotype.Service;

@Service
public class Faults {
  static class Gate {
    final String mode;
    final AtomicBoolean reached = new AtomicBoolean();
    final CountDownLatch release = new CountDownLatch(1);

    Gate(String mode) {
      this.mode = mode;
    }
  }

  private final ConcurrentHashMap<String, Gate> gates = new ConcurrentHashMap<>();
  private final TraceLog trace;

  public Faults(TraceLog trace) {
    this.trace = trace;
  }

  public void configure(String run, String point, String mode) {
    if (!Set.of(
                "after-redis-save",
                "before-activate",
                "after-revoke-commit",
                "before-revoke-commit")
            .contains(point)
        || !Set.of("fail", "pause", "release").contains(mode))
      throw new Failure(400, "INVALID_FAULT", "지원하지 않는 처리 지점입니다.");
    String key = run + ":" + point;
    Gate old = gates.remove(key);
    if (old != null) old.release.countDown();
    if (!mode.equals("release")) gates.put(key, new Gate(mode));
  }

  // flow:Faults.check
  public void check(String run, String point) {
    Gate g = gates.get(run + ":" + point);
    if (g == null || !g.reached.compareAndSet(false, true)) return;
    trace.step("Server", "fault_boundary", "실습 처리 지점 도달: " + point, "Faults.check");
    if (g.mode.equals("fail")) throw Failure.unavailable();
    try {
      if (!g.release.await(8, TimeUnit.SECONDS)) throw Failure.unavailable();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw Failure.unavailable();
    }
  }

  public List<Map<String, Object>> status(String run) {
    return gates.entrySet().stream()
        .filter(e -> e.getKey().startsWith(run + ":"))
        .map(
            e ->
                Map.<String, Object>of(
                    "point",
                    e.getKey().substring(run.length() + 1),
                    "mode",
                    e.getValue().mode,
                    "reached",
                    e.getValue().reached.get()))
        .toList();
  }
}
