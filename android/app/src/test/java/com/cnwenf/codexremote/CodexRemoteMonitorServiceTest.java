package com.cnwenf.codexremote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class CodexRemoteMonitorServiceTest {
    @Test
    public void runningThreadsUseStableDistinctNotificationIds() {
        int first = CodexRemoteMonitorService.runningNotificationId("thread-one");
        int second = CodexRemoteMonitorService.runningNotificationId("thread-two");

        assertEquals(first, CodexRemoteMonitorService.runningNotificationId("thread-one"));
        assertNotEquals(CodexRemoteMonitorService.ONGOING_ID, first);
        assertNotEquals(first, second);
    }
}
