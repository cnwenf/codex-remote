package com.cnwenf.codexremote;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class NotificationTracker {
    private static final int LIMIT = 200;
    private final Map<String, String> previous = new LinkedHashMap<>();
    private final Set<String> seen = new LinkedHashSet<>();
    private final Map<String, String> turns = new LinkedHashMap<>();
    private boolean initialized;
    NotificationTracker() {}
    NotificationTracker(Map<String, String> states, List<String> seen, boolean initialized) {
        this(states, seen, initialized, java.util.Collections.emptyMap());
    }
    NotificationTracker(Map<String, String> states, List<String> seen, boolean initialized, Map<String, String> turns) {
        this.previous.putAll(states);
        this.seen.addAll(seen);
        this.initialized = initialized;
        this.turns.putAll(turns);
        trim();
    }

    List<String> completions(List<String> ids) {
        return completions(ids, java.util.Collections.emptySet());
    }
    List<String> completions(List<String> ids, Set<String> initialEligible) {
        List<String> fresh = new ArrayList<>();
        for (String id : ids) {
            if (seen.add(id) && (initialized || initialEligible.contains(id))) fresh.add(id);
        }
        initialized = true;
        trim();
        return fresh;
    }

    String turnId(String threadId) { return turns.get(threadId); }
    boolean acknowledge(String id) { boolean fresh = seen.add(id); trim(); return fresh; }
    static String completionKey(String threadId, String turnId) { return threadId + "\u0000" + turnId; }

    List<String> transitions(Map<String, String> current) {
        return transitions(current, java.util.Collections.emptyMap());
    }
    List<String> transitions(Map<String, String> current, Map<String, String> turnIds) {
        List<String> finished = new ArrayList<>();
        for (Map.Entry<String, String> task : current.entrySet()) {
            String status = task.getValue();
            if (!"running".equals(status) && !"idle".equals(status) && !"error".equals(status)) continue;
            String prior = previous.remove(task.getKey());
            if (turnIds.containsKey(task.getKey())) turns.put(task.getKey(), turnIds.get(task.getKey()));
            else if ("running".equals(status) && !"running".equals(prior)) turns.remove(task.getKey());
            if ("running".equals(prior) && !"running".equals(status)) finished.add(task.getKey());
            previous.put(task.getKey(), status);
        }
        trim();
        return finished;
    }

    private void trim() {
        while (previous.size() > LIMIT) previous.remove(previous.keySet().iterator().next());
        turns.keySet().retainAll(previous.keySet());
        while (seen.size() > LIMIT) seen.remove(seen.iterator().next());
    }
    Map<String, String> states() { return new LinkedHashMap<>(previous); }
    Map<String, String> turns() { return new LinkedHashMap<>(turns); }
    List<String> seenIds() { return new ArrayList<>(seen); }
    boolean initialized() { return initialized; }
}
