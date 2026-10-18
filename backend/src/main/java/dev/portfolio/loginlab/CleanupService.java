package dev.portfolio.loginlab;

import java.util.*;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class CleanupService {
  private final Database db;
  private final SessionStore sessions;

  public CleanupService(Database db, SessionStore sessions) {
    this.db = db;
    this.sessions = sessions;
  }

  // flow:CleanupService.clean
  public void clean(UUID id) {
    String sid = sessions.locate(id.toString());
    if (sid == null) {
      db.sql.update(
          "UPDATE auth_cleanup_tasks SET state='WAITING_TTL',attempts=attempts+1,next_attempt_at=now()+interval '5 seconds' WHERE session_record_id=? AND state <> 'DONE'",
          id);
      return;
    }
    sessions.delete(sid);
    sessions.redis.delete("loginlab:ref:" + id);
    db.sql.update(
        "UPDATE auth_cleanup_tasks SET state='DONE',attempts=attempts+1 WHERE session_record_id=?",
        id);
  }

  @Scheduled(fixedDelay = 2000, initialDelay = 2000)
  public void sweep() {
    try {
      db.tx.executeWithoutResult(
          t -> {
            var expired =
                db.sql.queryForList(
                    "UPDATE auth_sessions SET state='REVOKED' WHERE state='PREPARING' AND preparing_expires_at<now() RETURNING id");
            for (var row : expired)
              db.sql.update(
                  "INSERT INTO auth_cleanup_tasks(id,session_record_id,reason) VALUES(?,?,'PREPARING_EXPIRED') ON CONFLICT(session_record_id) DO NOTHING",
                  UUID.randomUUID(),
                  row.get("id"));
            var tasks =
                db.sql.queryForList(
                    "SELECT c.id,c.session_record_id,s.absolute_expires_at FROM auth_cleanup_tasks c JOIN auth_sessions s ON s.id=c.session_record_id WHERE c.state IN ('PENDING','WAITING_TTL') AND c.next_attempt_at<=now() ORDER BY c.next_attempt_at LIMIT 8 FOR UPDATE OF c SKIP LOCKED");
            for (var row : tasks) {
              try {
                clean(UUID.fromString(row.get("session_record_id").toString()));
                if (Database.time(row, "absolute_expires_at")
                    .isBefore(java.time.Instant.now().minusSeconds(30)))
                  db.sql.update(
                      "UPDATE auth_cleanup_tasks SET state='EXPIRED' WHERE id=? AND state='WAITING_TTL'",
                      row.get("id"));
              } catch (Exception e) {
                db.sql.update(
                    "UPDATE auth_cleanup_tasks SET attempts=attempts+1,next_attempt_at=now()+interval '5 seconds' WHERE id=?",
                    row.get("id"));
              }
            }
          });
    } catch (Exception ignored) {
    }
  }
}
