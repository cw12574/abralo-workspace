import type { Activity, Message, WorkspaceEvent } from './index.js';
import { activityLabel } from './activity-label.js';

// Only display metadata belongs in history snapshots or their event journals.
export function activitySummary(activity: Activity): Activity {
  return {
    id: activity.id,
    type: activity.type,
    title: activity.title,
    // Worked out while the detail is still here; summaries drop the detail.
    label: activity.label ?? activityLabel(activity),
    state: activity.state,
    time: activity.time,
    updatedAt: activity.updatedAt,
    url: activity.url,
    textOffset: activity.textOffset,
    hasDetail: !!(activity.hasDetail || activity.detail),
  };
}

export function messageSummary(message: Message): Message {
  return message.activity?.length
    ? { ...message, activity: message.activity.map(activitySummary) }
    : message;
}

export function summaryEvent<T extends Pick<WorkspaceEvent, 'type' | 'payload'>>(event: T): T {
  if (event.type === 'activity.updated' && event.payload?.activity)
    return {
      ...event,
      payload: { ...event.payload, activity: activitySummary(event.payload.activity) },
    };
  if (event.payload?.activity instanceof Array)
    return { ...event, payload: messageSummary(event.payload) };
  return event;
}
