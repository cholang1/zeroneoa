import {useMemo, useState} from "react";
import {CalendarEvent, SessionUser, TeamState} from "@oa/contracts";
import {
    EventOccurrence,
    dateToWeekId,
    expandEvents,
    findUser,
    shiftDate,
    todayIso,
    weekIdToDateRange
} from "../../shared/utils";
import {Panel} from "../../shared/ui/Panel";
import {EventModal} from "./EventModal";

export function CalendarPanel({
                                  state,
                                  user,
                                  pickedDate,
                                  onAddEvent,
                                  onUpdateEvent,
                                  onDeleteEvent
                              }: {
    state: TeamState;
    user: SessionUser;
    pickedDate: string;
    onAddEvent: (
        input: Omit<CalendarEvent, "id" | "createdById" | "updatedById" | "createdAt" | "updatedAt">
    ) => void;
    onUpdateEvent: (id: string, patch: Partial<CalendarEvent>) => void;
    onDeleteEvent: (id: string) => void;
}) {
    const [view, setView] = useState<"week" | "month">("week");
    const [collapsed, setCollapsed] = useState(false);
    const [editing, setEditing] = useState<CalendarEvent | null>(null);
    const [adding, setAdding] = useState<{ date: string } | null>(null);

    const range = useMemo(() => {
        if (view === "week") {
            // Monday-based week containing pickedDate
            const wid = dateToWeekId(pickedDate);
            const r = weekIdToDateRange(wid);
            return r ?? {start: pickedDate, end: pickedDate};
        }
        // Month grid: week containing first of month → week containing last of month
        const first = pickedDate.slice(0, 7) + "-01";
        const lastDay = new Date(
            Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)
        )
            .toISOString()
            .slice(0, 10);
        const startWeek = weekIdToDateRange(dateToWeekId(first));
        const endWeek = weekIdToDateRange(dateToWeekId(lastDay));
        return {
            start: startWeek?.start ?? first,
            end: endWeek?.end ?? lastDay
        };
    }, [view, pickedDate]);

    const occurrences = useMemo(
        () => expandEvents(state.events ?? [], range.start, range.end),
        [state.events, range.start, range.end]
    );

    function eventsOnDate(date: string) {
        return occurrences.filter((o) => o.date === date);
    }

    function todayCheck(date: string) {
        return date === todayIso();
    }

    function eventColor(ev: CalendarEvent) {
        return findUser(state.users, ev.createdById)?.color ?? "var(--primary)";
    }

    return (
        <Panel
            title="日历"
            kicker={view === "week" ? "本周" : "本月"}
            actions={
                <div className="panel-actions calendar-actions">
                    <div className="segmented small">
                        <button className={view === "week" ? "active" : ""} onClick={() => setView("week")}>
                            周
                        </button>
                        <button className={view === "month" ? "active" : ""} onClick={() => setView("month")}>
                            月
                        </button>
                    </div>
                    <button
                        className="compact-action"
                        onClick={() => setAdding({date: pickedDate})}
                    >
                        ＋ 新建事件
                    </button>
                    <button
                        className="text-button mini"
                        onClick={() => setCollapsed((value) => !value)}
                    >
                        {collapsed ? "\u5c55\u5f00" : "\u6536\u8d77"}
                    </button>
                </div>
            }
        >
            {!collapsed && (view === "week" ? (
                <CalendarWeekGrid
                    rangeStart={range.start}
                    eventsOnDate={eventsOnDate}
                    eventColor={eventColor}
                    today={todayCheck}
                    onClickDay={(date) => setAdding({date})}
                    onClickEvent={(ev) => setEditing(ev)}
                />
            ) : (
                <CalendarMonthGrid
                    rangeStart={range.start}
                    rangeEnd={range.end}
                    monthOf={pickedDate.slice(0, 7)}
                    eventsOnDate={eventsOnDate}
                    eventColor={eventColor}
                    today={todayCheck}
                    onClickDay={(date) => setAdding({date})}
                    onClickEvent={(ev) => setEditing(ev)}
                />
            ))}

            {(adding || editing) && (
                <EventModal
                    state={state}
                    user={user}
                    existing={editing}
                    defaultDate={adding?.date}
                    onClose={() => {
                        setAdding(null);
                        setEditing(null);
                    }}
                    onSave={(input) => {
                        if (editing) onUpdateEvent(editing.id, input);
                        else onAddEvent(input);
                        setAdding(null);
                        setEditing(null);
                    }}
                    onDelete={
                        editing
                            ? () => {
                                if (window.confirm("删除这个事件？")) {
                                    onDeleteEvent(editing.id);
                                    setEditing(null);
                                }
                            }
                            : undefined
                    }
                />
            )}
        </Panel>
    );
}

export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export function CalendarWeekGrid({
                                     rangeStart,
                                     eventsOnDate,
                                     eventColor,
                                     today,
                                     onClickDay,
                                     onClickEvent
                                 }: {
    rangeStart: string;
    eventsOnDate: (date: string) => EventOccurrence[];
    eventColor: (ev: CalendarEvent) => string;
    today: (date: string) => boolean;
    onClickDay: (date: string) => void;
    onClickEvent: (ev: CalendarEvent) => void;
}) {
    const days = Array.from({length: 7}, (_, i) => shiftDate(rangeStart, i));
    return (
        <div className="cal-week">
            {days.map((d, idx) => {
                const list = eventsOnDate(d);
                const isToday = today(d);
                return (
                    <div
                        key={d}
                        className={`cal-week-col${isToday ? " is-today" : ""}`}
                    >
                        <div className="cal-week-head">
                            <span className="dow">周{WEEKDAY_LABELS[idx]}</span>
                            <span className="dom">{d.slice(5)}</span>
                        </div>
                        <div className="cal-day-body">
                            {list.map((o) => (
                                <button
                                    key={`${o.event.id}-${o.date}`}
                                    className="cal-event-chip"
                                    style={{borderLeftColor: eventColor(o.event)}}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClickEvent(o.event);
                                    }}
                                >
                                    {o.event.startTime ? (
                                        <span className="time">{o.event.startTime}</span>
                                    ) : null}
                                    <span className="title">{o.event.title}</span>
                                    {o.event.recurrence && o.event.recurrence !== "none" ? (
                                        <span className="rec" title="重复事件">↻</span>
                                    ) : null}
                                </button>
                            ))}
                            <button className="cal-add-btn" onClick={() => onClickDay(d)}>
                                ＋
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export function CalendarMonthGrid({
                                      rangeStart,
                                      rangeEnd,
                                      monthOf,
                                      eventsOnDate,
                                      eventColor,
                                      today,
                                      onClickDay,
                                      onClickEvent
                                  }: {
    rangeStart: string;
    rangeEnd: string;
    monthOf: string;
    eventsOnDate: (date: string) => EventOccurrence[];
    eventColor: (ev: CalendarEvent) => string;
    today: (date: string) => boolean;
    onClickDay: (date: string) => void;
    onClickEvent: (ev: CalendarEvent) => void;
}) {
    const days: string[] = [];
    let cursor = rangeStart;
    let safety = 50;
    while (cursor <= rangeEnd && safety-- > 0) {
        days.push(cursor);
        cursor = shiftDate(cursor, 1);
    }
    return (
        <div className="cal-month">
            <div className="cal-month-head">
                {WEEKDAY_LABELS.map((d) => (
                    <div key={d} className="cal-month-dow">
                        周{d}
                    </div>
                ))}
            </div>
            <div className="cal-month-grid">
                {days.map((d) => {
                    const list = eventsOnDate(d);
                    const inMonth = d.startsWith(monthOf);
                    return (
                        <button
                            key={d}
                            className={`cal-month-cell${inMonth ? "" : " out"}${today(d) ? " is-today" : ""}`}
                            onClick={() => onClickDay(d)}
                        >
                            <span className="cell-date">{d.slice(8)}</span>
                            <div className="cell-events">
                                {list.slice(0, 3).map((o) => (
                                    <span
                                        key={`${o.event.id}-${o.date}`}
                                        className="cal-event-pill"
                                        style={{background: eventColor(o.event)}}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onClickEvent(o.event);
                                        }}
                                        title={`${o.event.startTime ?? ""} ${o.event.title}`}
                                    >
                    {o.event.startTime ? `${o.event.startTime} ` : ""}
                                        {o.event.title}
                  </span>
                                ))}
                                {list.length > 3 ? (
                                    <span className="cal-more">+{list.length - 3}</span>
                                ) : null}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
