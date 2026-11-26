import {User} from "@oa/contracts";
import {OaPicker} from "../../shared/ui/OaPicker";

export function MemoMentionPicker({users, currentUserId, mentionAll, mentionUserIds, label, onChange}: {
    users: User[]; currentUserId: string; mentionAll: boolean; mentionUserIds: string[];
    label: string; onChange: (mentionAll: boolean, mentionUserIds: string[]) => void;
}) {
    return <OaPicker name="备忘提醒" summary={label} triggerClass="memo-mentions" minWidth={220}
                     search={users.length >= 8 ? "搜索提醒对象" : undefined}
                     value={mentionAll ? ["all"] : mentionUserIds.length ? mentionUserIds.map(id => `user:${id}`) : ["none"]}
                     options={[{value: "none", label: "不提醒"}, {value: "all", label: "@全体"},
                         ...users.map(user => ({value: `user:${user.id}`, group: "成员",
                             label: user.name + (user.id === currentUserId ? "（我）" : "")}))]}
                     onPick={key => {
                         if (key === "all" || key === "none") return onChange(key === "all", []);
                         const id = key.slice(5);
                         onChange(false, mentionAll ? [id] : mentionUserIds.includes(id)
                             ? mentionUserIds.filter(item => item !== id) : [...mentionUserIds, id]);
                     }}/>;
}
