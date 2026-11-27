type ProgressStatus = "pending" | "done" | "error";

export function ZeroAiProgressIcon({status}: { status: ProgressStatus }) {
    return (
        <svg aria-hidden="true" focusable="false" className="zero-ai-progress-icon" data-status={status}
             width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" opacity={status === "pending" ? 0.22 : 1}/>
            {status === "pending" ? <path d="M8 2a6 6 0 0 1 6 6"/>
                : status === "done" ? <path d="m5 8 2 2 4-4"/>
                    : <path d="M8 4.8v3.6M8 11.1v.1"/>}
        </svg>
    );
}
