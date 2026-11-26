import {useEffect, useRef, CSSProperties, ChangeEvent, FocusEvent, KeyboardEvent} from "react";

export function AutoGrowTextarea({
                                     value,
                                     defaultValue,
                                     placeholder,
                                     style,
                                     onChange,
                                     onBlur,
                                     onKeyDown
                                 }: {
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    style?: CSSProperties;
    onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
    const ref = useRef<HTMLTextAreaElement>(null);

    function resize(element: HTMLTextAreaElement) {
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
    }

    useEffect(() => {
        if (ref.current) resize(ref.current);
    }, [value, defaultValue]);

    return (
        <textarea
            ref={ref}
            value={value}
            defaultValue={defaultValue}
            placeholder={placeholder}
            style={style}
            rows={1}
            onInput={(event) => resize(event.currentTarget)}
            onChange={onChange}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
        />
    );
}
