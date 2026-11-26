import {useState} from "react";

export function Panel({
                          title,
                          kicker,
                          children,
                          actions,
                          className,
                          collapsible,
                          defaultOpen = true
                      }: {
    title: string;
    kicker?: string;
    children: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
    collapsible?: boolean;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <section className={className ? `panel ${className}` : "panel"}>
            <div className="panel-head">
                <div
                    className={collapsible ? "panel-titles collapsible" : "panel-titles"}
                    onClick={collapsible ? () => setOpen((value) => !value) : undefined}
                >
                    {kicker ? <p className="kicker">{kicker}</p> : null}
                    <h3>
                        {title}
                        {collapsible ? <span className="panel-caret">{open ? "▲" : "▼"}</span> : null}
                    </h3>
                </div>
                {actions}
            </div>
            {collapsible && !open ? null : children}
        </section>
    );
}
