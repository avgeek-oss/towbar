"use client";
import { useLayoutEffect, useRef } from "react";
import { registerDraft } from "@/lib/unsaved-navigation";

export function useUnsavedChanges(dirty: boolean) {
  const id = useRef(Symbol("draft"));
  useLayoutEffect(() => {
    const token = id.current;
    registerDraft(token, dirty);
    return () => registerDraft(token, false);
  }, [dirty]);
  return () => registerDraft(id.current, false);
}

function formValues(form: HTMLElement) {
  return JSON.stringify(
    [
      ...form.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("input:not([type=hidden]), textarea, select"),
    ]
      .filter(
        (field) => !field.disabled && !("readOnly" in field && field.readOnly),
      )
      .map((field) => [
        field.id || field.name,
        field instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(field.type)
          ? field.checked
          : field.value,
      ]),
  );
}
export function useUnsavedForm<T extends HTMLElement = HTMLFormElement>() {
  const ref = useRef<T>(null);
  const baseline = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const id = useRef(Symbol("form-draft"));
  useLayoutEffect(() => {
    const token = id.current;
    return () => registerDraft(token, false);
  }, []);
  useLayoutEffect(() => {
    if (!dirty.current && ref.current)
      baseline.current = formValues(ref.current);
  });
  const changed = () => {
    if (ref.current) {
      dirty.current = formValues(ref.current) !== baseline.current;
      registerDraft(id.current, dirty.current);
    }
  };
  return {
    formProps: {
      ref,
      onInputCapture: changed,
      onChangeCapture: changed,
      onFocusCapture: () => {
        if (!dirty.current && ref.current)
          baseline.current = formValues(ref.current);
      },
    },
    markSaved: () => {
      if (ref.current) baseline.current = formValues(ref.current);
      dirty.current = false;
      registerDraft(id.current, false);
    },
  };
}
