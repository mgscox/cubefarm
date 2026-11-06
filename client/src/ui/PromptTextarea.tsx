import { useEffect, useRef, useState, type ClipboardEvent, type TextareaHTMLAttributes, type Ref } from 'react';
import { api } from '../api';
import { useStore } from '../store';

// Keep attachments as ordinary links so every existing prompt, issue and brief can carry them.
let pasteSequence = 0;
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onValueCommit?: (value: string) => void;
  ref?: Ref<HTMLTextAreaElement>;
};

export function PromptTextarea({ value, defaultValue = '', onValueChange, onValueCommit, onChange, onPaste, onBlur, ref, ...rest }: Props) {
  const [draft, setDraft] = useState(defaultValue);
  const current = useRef(value ?? draft);
  current.current = value ?? draft;
  const mounted = useRef(true);
  const pending = useRef(0);
  const commitAfterUpload = useRef(false);
  const unblock = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; unblock.current?.(); };
  }, []);

  const update = (text: string) => {
    current.current = text;
    if (value === undefined) setDraft(text);
    onValueChange?.(text);
  };

  const paste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented || rest.disabled || rest.readOnly) return;
    const files = [...event.clipboardData.items].filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    const el = event.currentTarget;
    const token = `[Uploading image ${++pasteSequence}…]`;
    const next = `${current.current.slice(0, el.selectionStart)}${token}${current.current.slice(el.selectionEnd)}`;
    if (rest.maxLength && next.length > rest.maxLength) {
      useStore.getState().pushToast('error', 'There is not enough room for an image link in this field.');
      return;
    }
    update(next);
    pending.current++;
    // Most prompts submit a form; floor briefs save through neighbouring buttons instead.
    if (!unblock.current) {
      const scope = el.form ?? el.parentElement!;
      const block = (e: Event) => {
        if (e.type === 'click' && !(e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().pushToast('error', 'Wait for the image upload to finish.');
      };
      scope.addEventListener('submit', block, true);
      scope.addEventListener('click', block, true);
      unblock.current = () => {
        scope.removeEventListener('submit', block, true);
        scope.removeEventListener('click', block, true);
        unblock.current = null;
      };
    }
    try {
      const links: string[] = [];
      for (const file of files) links.push(await api.uploadImage(file));
      if (mounted.current) {
        const replacement = links.join('\n');
        const result = current.current.replace(token, replacement);
        if (rest.maxLength && result.length > rest.maxLength) throw new Error('The image links exceed this field’s character limit.');
        update(result);
      }
    } catch (err) {
      if (mounted.current) {
        update(current.current.replace(token, ''));
        useStore.getState().pushToast('error', err instanceof Error ? err.message : 'Image upload failed. Paste again to retry.');
      }
    } finally {
      pending.current--;
      if (!pending.current) {
        unblock.current?.();
        if (mounted.current && commitAfterUpload.current) {
          commitAfterUpload.current = false;
          onValueCommit?.(current.current);
        }
      }
    }
  };

  return <textarea {...rest} ref={ref} value={value ?? draft} onChange={(e) => { update(e.target.value); onChange?.(e); }} onPaste={(e) => void paste(e)} onBlur={(e) => {
    onBlur?.(e);
    if (pending.current) commitAfterUpload.current = true;
    else onValueCommit?.(current.current);
  }} />;
}
