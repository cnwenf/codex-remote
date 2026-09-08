package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class NotificationTrackerTest {
    @Test public void firstResponseDeliversOnlyEligibleNewCompletions() {
        NotificationTracker tracker = new NotificationTracker();
        assertEquals(Arrays.asList("during-connect"), tracker.completions(Arrays.asList("old", "during-connect"), Collections.singleton("during-connect")));
        assertTrue(tracker.completions(Arrays.asList("old", "during-connect")).isEmpty());
    }

    @Test public void unifiesTurnIdentityAcrossFallbackAndLateCompletion() {
        NotificationTracker tracker = new NotificationTracker();
        tracker.completions(Collections.emptyList());
        tracker.transitions(Collections.singletonMap("t", "running"), Collections.singletonMap("t", "one"));
        assertEquals(Arrays.asList("t"), tracker.transitions(Collections.singletonMap("t", "idle"), Collections.emptyMap()));
        assertEquals("one", tracker.turnId("t"));
        assertTrue(tracker.acknowledge(NotificationTracker.completionKey("t", "one")));
        assertTrue(tracker.completions(Arrays.asList(NotificationTracker.completionKey("t", "one"))).isEmpty());
        tracker.transitions(Collections.singletonMap("t", "running"), Collections.emptyMap());
        assertNull("A new unidentified turn must not inherit the completed turn ID", tracker.turnId("t"));
        assertEquals(Arrays.asList("t"), tracker.transitions(Collections.singletonMap("t", "idle")));
    }

    @Test public void eventFirstIsNotNotifiedAgainByTheStateFallback() {
        NotificationTracker tracker = new NotificationTracker();
        tracker.completions(Collections.emptyList());
        String key = NotificationTracker.completionKey("t", "one");
        assertEquals(Arrays.asList(key), tracker.completions(Arrays.asList(key)));
        assertFalse(tracker.acknowledge(key));
    }
    @Test public void ignoresInitialHistoryThenDeliversShortTurnsOnce() {
        NotificationTracker tracker = new NotificationTracker();
        assertTrue(tracker.completions(Arrays.asList("old")).isEmpty());
        assertEquals(Arrays.asList("fast-one", "fast-two"), tracker.completions(Arrays.asList("old", "fast-one", "fast-two")));
        assertTrue(tracker.completions(Arrays.asList("old", "fast-one", "fast-two")).isEmpty());
    }

    @Test public void retainsRunningAcrossUnknownAndMissingLegacySnapshots() {
        NotificationTracker tracker = new NotificationTracker();
        assertTrue(tracker.transitions(Collections.singletonMap("t", "running")).isEmpty());
        assertTrue(tracker.transitions(Collections.singletonMap("t", "unknown")).isEmpty());
        assertTrue(tracker.transitions(Collections.emptyMap()).isEmpty());
        assertEquals(Arrays.asList("t"), tracker.transitions(Collections.singletonMap("t", "idle")));
        assertTrue(tracker.transitions(Collections.singletonMap("t", "idle")).isEmpty());
    }

    @Test public void restoresDeduplicationAfterServiceRestartAndBoundsMemory() {
        NotificationTracker tracker = new NotificationTracker();
        tracker.completions(Arrays.asList("old"));
        NotificationTracker restored = new NotificationTracker(tracker.states(), tracker.seenIds(), tracker.initialized());
        assertTrue(restored.completions(Arrays.asList("old")).isEmpty());
        assertEquals(Arrays.asList("next"), restored.completions(Arrays.asList("next")));
        Map<String, String> tasks = new LinkedHashMap<>();
        for (int i = 0; i < 500; i++) {
            tasks.put("t" + i, "running");
            restored.completions(Arrays.asList("e" + i));
        }
        restored.transitions(tasks);
        assertTrue(restored.states().size() <= 200);
        assertTrue(restored.seenIds().size() <= 200);
    }
}
