package dev.portfolio.loginlab;

import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class Database {
  public final JdbcTemplate sql;
  public final TransactionTemplate tx;

  public Database(
      JdbcTemplate sql, org.springframework.transaction.PlatformTransactionManager manager) {
    this.sql = sql;
    tx = new TransactionTemplate(manager);
    tx.setTimeout(5);
  }

  public Map<String, Object> one(String q, Object... args) {
    List<Map<String, Object>> l = sql.queryForList(q, args);
    return l.isEmpty() ? null : l.getFirst();
  }

  public static Instant time(Map<String, Object> r, String key) {
    Object v = r.get(key);
    if (v == null) return null;
    if (v instanceof Timestamp t) return t.toInstant();
    if (v instanceof OffsetDateTime t) return t.toInstant();
    return Instant.parse(v.toString());
  }

  public static long number(Map<String, Object> r, String key) {
    return ((Number) r.get(key)).longValue();
  }

  public static UUID uuid(Map<String, Object> r, String key) {
    return UUID.fromString(r.get(key).toString());
  }

  public static Timestamp stamp(Instant v) {
    return Timestamp.from(v);
  }
}
