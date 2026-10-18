package dev.portfolio.loginlab;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class TraceLog {
  public record Step(String node, String action, String message, String source, String at) {}

  public static class Entry {
    public String id, runId, instance, method, path, startedAt, finishedAt;
    public int status;
    public List<Step> steps = new ArrayList<>();
  }

  private final ThreadLocal<Entry> current = new ThreadLocal<>();
  private final ConcurrentLinkedDeque<Entry> history = new ConcurrentLinkedDeque<>();
  private final String instance;

  public TraceLog(@Value("${lab.instance}") String instance) {
    this.instance = instance;
  }

  public void begin(String run, String method, String path, String id) {
    Entry e = new Entry();
    e.id = id;
    e.runId = run;
    e.instance = instance;
    e.method = method;
    e.path = path;
    e.startedAt = Instant.now().toString();
    current.set(e);
    step("Browser", "request", "실제 HTTPS API 요청 수신", "TraceFilter.request");
  }

  public void step(String node, String action, String message, String source) {
    Entry e = current.get();
    if (e != null) e.steps.add(new Step(node, action, message, source, Instant.now().toString()));
  }

  public String id() {
    return current.get() == null ? "background" : current.get().id;
  }

  // flow:TraceLog.finish
  public void finish(int status) {
    Entry e = current.get();
    if (e == null) return;
    step("Browser", "response", "서버 HTTP " + status + " 응답 생성", "TraceLog.finish");
    e.status = status;
    e.finishedAt = Instant.now().toString();
    history.addFirst(e);
    while (history.size() > 600) history.pollLast();
    current.remove();
  }

  public List<Entry> list(String run) {
    return history.stream().filter(e -> e.runId.equals(run)).limit(100).toList();
  }

  public void clear(String run) {
    history.removeIf(e -> e.runId.equals(run));
  }
}
