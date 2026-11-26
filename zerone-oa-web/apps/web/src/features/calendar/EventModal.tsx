import {OaPicker} from "../../shared/ui/OaPicker";
import {useState} from "react";
import {CalendarEvent, Recurrence, SessionUser, TeamState} from "@oa/contracts";
import {todayIso} from "../../shared/utils";
import {ParticipantPicker} from "./ParticipantPicker";

export function EventModal({
                               state,
                               user,
                               existing,
                               defaultDate,
                               onSave,
                               onDelete,
                               onClose
                           }: {
    state: TeamState;
    user: SessionUser;
    existing: CalendarEvent | null;
    defaultDate?: string;
    onSave: (
        input: Omit<CalendarEvent, "id" | "createdById" | "updatedById" | "createdAt" | "updatedAt">
    ) => void;
    onDelete?: () => void;
    onClose: () => void;
}) {
    const [title, setTitle] = useState(existing?.title ?? "");
    const [startDate, setStartDate] = useState(existing?.startDate ?? defaultDate ?? todayIso());
    const [startTime, setStartTime] = useState(existing?.startTime ?? "");
    const [endTime, setEndTime] = useState(existing?.endTime ?? "");
    const [location, setLocation] = useState(existing?.location ?? "杭州办公室");
    const [meetingLink, setMeetingLink] = useState(existing?.meetingLink ?? "");
    const [notes, setNotes] = useState(existing?.notes ?? "");
    const [recurrence, setRecurrence] = useState<Recurrence>(existing?.recurrence ?? "none");
    const [recurrenceEnd, setRecurrenceEnd] = useState(existing?.recurrenceEnd ?? "");
    const [participantIds, setParticipantIds] = useState<string[]>(
        existing?.participantIds ?? [user.id]
    );

    function commit() {
        if (!title.trim()) {
            window.alert("请填写事件标题。");
            return;
        }
        onSave({
            title: title.trim(),
            startDate,
            startTime: startTime || undefined,
            endTime: endTime || undefined,
            location: location.trim() || undefined,
            meetingLink: meetingLink.trim() || undefined,
            notes: notes.trim() || undefined,
            participantIds,
            recurrence,
            recurrenceEnd: recurrence === "none" ? undefined : recurrenceEnd || undefined
        });
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>{existing ? "编辑事件" : "新建事件"}</h3>
                    <button className="icon-btn" onClick={onClose} title="关闭">
                        ✕
                    </button>
                </div>
                <div className="modal-body">
                    <label>
                        标题
                        <input
                            autoFocus
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="例如：周例会 / 方案评审"
                        />
                    </label>
                    <div className="form-row">
                        <label>
                            日期
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                            />
                        </label>
                        <label>
                            开始
                            <input
                                type="time"
                                value={startTime}
                                onChange={(e) => setStartTime(e.target.value)}
                            />
                        </label>
                        <label>
                            结束
                            <input
                                type="time"
                                value={endTime}
                                onChange={(e) => setEndTime(e.target.value)}
                            />
                        </label>
                    </div>
                    <div className="form-row">
                        <label>
                            地点
                            <input
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                placeholder="会议室 A / 线上"
                            />
                        </label>
                        <label>
                            会议链接
                            <input
                                value={meetingLink}
                                onChange={(e) => setMeetingLink(e.target.value)}
                                placeholder="https://..."
                            />
                        </label>
                    </div>
                    <div className="form-row">
                        <div className="form-field"><span className="form-label">重复</span>
                            <OaPicker name="重复" value={recurrence} onPick={id => setRecurrence(id as Recurrence)}
                                      options={[
                                          {value: "none", label: "不重复"}, {value: "daily", label: "每天"},
                                          {value: "weekly", label: "每周"}, {value: "biweekly", label: "隔周"},
                                          {value: "monthly", label: "每月"}
                                      ]}/>
                        </div>
                        {recurrence !== "none" ? (
                            <label>
                                重复结束于
                                <input
                                    type="date"
                                    value={recurrenceEnd}
                                    onChange={(e) => setRecurrenceEnd(e.target.value)}
                                />
                            </label>
                        ) : null}
                    </div>
                    <div className="form-field">
                        <span className="form-label">参与者（@ 提醒）</span>
                        <ParticipantPicker
                            users={state.users}
                            currentUserId={user.id}
                            value={participantIds}
                            onChange={setParticipantIds}
                        />
                    </div>
                    <label>
                        会议记录 / 议程
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={4}
                            placeholder="议程、纪要、链接..."
                        />
                    </label>
                </div>
                <div className="modal-foot">
                    {onDelete ? (
                        <button className="text-button" onClick={onDelete}>
                            删除事件
                        </button>
                    ) : (
                        <span/>
                    )}
                    <div className="modal-foot-right">
                        <button className="text-button" onClick={onClose}>
                            取消
                        </button>
                        <button className="primary-action" onClick={commit}>
                            保存
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
