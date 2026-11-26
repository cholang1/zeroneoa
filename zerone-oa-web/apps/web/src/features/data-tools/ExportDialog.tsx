import {useMemo, useState} from "react";
import {TeamState} from "@oa/contracts";
import {todayIso} from "../../shared/utils";
import {ExportKind, ExportRange, EXPORT_RANGES, exportSince, sliceStateSince} from "./exports";

export function ExportDialog({
                                 state,
                                 onExport,
                                 onClose
                             }: {
    state: TeamState;
    onExport: (kind: ExportKind, range: ExportRange) => void;
    onClose: () => void;
}) {
    const [range, setRange] = useState<ExportRange>("1w");
    const [kind, setKind] = useState<ExportKind>("json");
    const since = exportSince(range);
    const slice = useMemo(() => sliceStateSince(state, since), [state, since]);
    const counts: Array<[string, number]> = [
        ["日报", slice.dailyReports.length],
        ["工作内容", slice.weeklyPlans.length],
        ["评论区", (slice.dayThreads ?? []).length],
        ["备忘", slice.memos.length],
        ["日历", (slice.events ?? []).length]
    ];

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal export-modal" onClick={(event) => event.stopPropagation()}>
                <div className="modal-head">
                    <h3>导出数据</h3>
                    <button className="icon-btn" onClick={onClose} title="关闭">
                        ✕
                    </button>
                </div>
                <div className="modal-body">
                    <div className="form-field">
                        <span className="form-label">时间范围</span>
                        <div className="segmented">
                            {EXPORT_RANGES.map((item) => (
                                <button
                                    key={item.key}
                                    className={range === item.key ? "active" : ""}
                                    onClick={() => setRange(item.key)}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <span className="export-range-note">
              {since ? `${since} 至 ${todayIso()}（含今天）` : "全部历史数据 · 完整备份，可用于导入恢复"}
            </span>
                    </div>
                    <div className="form-field">
                        <span className="form-label">格式</span>
                        <div className="segmented">
                            <button className={kind === "json" ? "active" : ""} onClick={() => setKind("json")}>
                                JSON
                            </button>
                            <button className={kind === "csv" ? "active" : ""} onClick={() => setKind("csv")}>
                                CSV 数据包
                            </button>
                        </div>
                    </div>
                    <p className="export-summary">
                        将导出：{counts.map(([label, count]) => `${label} ${count}`).join(" · ")}
                    </p>
                    <p className="export-hint">
                        任务树和成员名单始终完整导出；日报按日期、工作内容按周、评论区按日期或评论时间筛选。
                    </p>
                </div>
                <div className="modal-foot">
                    <span/>
                    <div className="modal-foot-right">
                        <button className="text-button" onClick={onClose}>
                            取消
                        </button>
                        <button className="primary-action" onClick={() => onExport(kind, range)}>
                            导出
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
