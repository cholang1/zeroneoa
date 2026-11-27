import {User} from "@oa/contracts";
import {findUser} from "../../shared/utils";
import {OaPicker} from "../../shared/ui/OaPicker";

export function ParticipantPicker({users, currentUserId, value, onChange}: {
    users: User[]; currentUserId: string; value: string[]; onChange: (next: string[]) => void;
}) {
    const summary = value.length ? value.slice(0, 3).map(id => findUser(users, id)?.name ?? id).join("、")
        + (value.length > 3 ? ` 等 ${value.length} 人` : "") : "点击选择参与者…";
    return <OaPicker name="参与者" search="搜索姓名" summary={summary} minWidth={260} value={value}
                     options={users.map(user => {
                         const label = user.name + (user.id === currentUserId ? "（我）" : "");
                         return {
                             value: user.id, label, content: <span className="oa-picker-person">
                             <i aria-hidden="true" style={{backgroundColor: user.color}}/>{label}</span>
                         };
                     })}
                     onPick={id => onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id])}
                     footer={close => <><span>已选 {value.length} 人</span>
                         {value.length > 0 && <button type="button" className="text-button mini"
                                                      onClick={() => onChange([])}>清空</button>}
                         <button type="button" className="primary-action small" onClick={close}>完成</button>
                     </>}/>;
}
