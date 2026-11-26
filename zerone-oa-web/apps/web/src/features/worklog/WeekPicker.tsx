import {OaPicker} from "../../shared/ui/OaPicker";
import {TeamState} from "@oa/contracts";
import {dateToWeekId, weekIdToDateRange} from "../../shared/utils";
import {uniqueWeekIds, weekLabel} from "../../shared/weeks";

export function WeekPicker({
                               pickedDate,
                               onPickedDateChange,
                               state
                           }: {
    pickedDate: string;
    onPickedDateChange: (date: string) => void;
    state: TeamState;
}) {
    const weekId = dateToWeekId(pickedDate);

    function shift(delta: number) {
        const d = new Date(pickedDate + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + delta * 7);
        onPickedDateChange(d.toISOString().slice(0, 10));
    }

    function openNativePicker(event: React.MouseEvent<HTMLInputElement>) {
        const el = event.currentTarget as HTMLInputElement & { showPicker?: () => void };
        try {
            el.showPicker?.();
        } catch {
            /* unsupported browser — native click still works */
        }
    }

    return (
        <div className="week-picker">
            <button className="icon-btn" onClick={() => shift(-1)} title="上一周">
                ‹
            </button>
            <input
                type="date"
                className="date-input"
                value={pickedDate}
                onClick={openNativePicker}
                onChange={(event) => {
                    if (event.target.value) onPickedDateChange(event.target.value);
                }}
            />
            <span className="week-label">{weekLabel(weekId)}</span>
            <button className="icon-btn" onClick={() => shift(1)} title="下一周">
                ›
            </button>
            <OaPicker name="周次" value={weekId}
                      options={uniqueWeekIds(state, weekId).map(week => ({value: week, label: week}))}
                      onPick={week => {
                          const range = weekIdToDateRange(week);
                          if (range) onPickedDateChange(range.start);
                      }}/>
        </div>
    );
}
