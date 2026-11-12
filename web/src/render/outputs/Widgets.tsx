// Native views for the core ipywidgets: layout boxes, text, progress bars, and the usual
// controls. Enough for tqdm, `interact`, and hand-built control panels.

import DOMPurify from 'dompurify';
import { createMemo, For, type JSX, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { modelRef, sendWidgetEvent, updateWidget, widgetModel, type WidgetModel } from '../../kernel/widgets';
import type { Output } from '../../notebook/nbformat';
import { OutputView, registerRenderer } from './Outputs';

import '../../styles/widgets.css';

type WidgetProps = { model: WidgetModel };

const LAYOUT_PROPERTIES = [
  'width', 'height', 'min_width', 'max_width', 'min_height', 'max_height', 'margin', 'padding',
  'display', 'flex', 'flex_flow', 'justify_content', 'align_items', 'align_self', 'align_content',
  'overflow', 'visibility', 'order', 'border', 'border_top', 'border_right', 'border_bottom', 'border_left',
  'grid_template_columns', 'grid_template_rows', 'grid_template_areas', 'grid_gap', 'grid_area',
  'grid_auto_flow', 'grid_auto_columns', 'grid_auto_rows', 'justify_items', 'object_fit', 'object_position',
];

/** A widget's `layout` is itself a model whose traits are CSS properties. */
function layoutStyle(model: WidgetModel): JSX.CSSProperties {
  const layout = widgetModel(modelRef(model.state.layout));
  const style: Record<string, string> = {};
  if (!layout) return style;
  for (const property of LAYOUT_PROPERTIES) {
    const value = layout.state[property];
    if (typeof value === 'string' && value) style[property.replace(/_/g, '-')] = value;
  }
  return style;
}

function styleModel(model: WidgetModel): Record<string, any> {
  return widgetModel(modelRef(model.state.style))?.state ?? {};
}

function Described(props: { model: WidgetModel; class?: string; children: JSX.Element }) {
  const width = () => styleModel(props.model).description_width as string | undefined;
  return (
    <div class={`w-control ${props.class ?? ''}`} style={layoutStyle(props.model)}>
      <Show when={props.model.state.description}>
        <label class="w-description" style={width() ? { width: width(), 'flex-basis': width() } : undefined} title={props.model.state.description}>
          {props.model.state.description}
        </label>
      </Show>
      {props.children}
    </div>
  );
}

// ── Containers ──────────────────────────────────────────────────────────────

function Children(props: { model: WidgetModel }) {
  const ids = createMemo(() => ((props.model.state.children as unknown[]) ?? []).map(modelRef).filter((id): id is string => !!id));
  return <For each={ids()}>{(id) => <WidgetNode id={id} />}</For>;
}

function Box(props: WidgetProps & { direction?: 'row' | 'column' }) {
  const state = props.model.state;
  return (
    <div
      class="w-box"
      classList={{
        'w-hbox': state._model_name === 'HBoxModel',
        'w-vbox': state._model_name === 'VBoxModel',
        'w-grid': state._model_name === 'GridBoxModel',
        'w-interact': Array.isArray(state._dom_classes) && state._dom_classes.includes('widget-interact'),
      }}
      style={layoutStyle(props.model)}
    >
      <Children model={props.model} />
    </div>
  );
}

function titlesOf(state: Record<string, any>, count: number): string[] {
  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    titles.push((Array.isArray(state.titles) ? state.titles[i] : state._titles?.[i]) || `Tab ${i + 1}`);
  }
  return titles;
}

function Tabs(props: WidgetProps) {
  const state = props.model.state;
  const ids = createMemo(() => ((state.children as unknown[]) ?? []).map(modelRef).filter((id): id is string => !!id));
  const selected = () => (typeof state.selected_index === 'number' ? state.selected_index : 0);
  return (
    <div class="w-tabs" style={layoutStyle(props.model)}>
      <div class="w-tab-bar">
        <For each={titlesOf(state, ids().length)}>
          {(title, i) => (
            <button class="w-tab" classList={{ active: selected() === i() }} onClick={() => updateWidget(props.model, { selected_index: i() })}>
              {title}
            </button>
          )}
        </For>
      </div>
      <Show when={ids()[selected()]} keyed>
        {(id) => <WidgetNode id={id} />}
      </Show>
    </div>
  );
}

function Accordion(props: WidgetProps) {
  const state = props.model.state;
  const ids = createMemo(() => ((state.children as unknown[]) ?? []).map(modelRef).filter((id): id is string => !!id));
  return (
    <div class="w-accordion" style={layoutStyle(props.model)}>
      <For each={ids()}>
        {(id, i) => (
          <div class="w-accordion-item">
            <button
              class="w-accordion-title"
              onClick={() => updateWidget(props.model, { selected_index: state.selected_index === i() ? null : i() })}
            >
              <span class="w-chevron" classList={{ open: state.selected_index === i() }}>
                ▸
              </span>
              {titlesOf(state, ids().length)[i()]}
            </button>
            <Show when={state.selected_index === i()}>
              <div class="w-accordion-body">
                <WidgetNode id={id} />
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

// ── Display ─────────────────────────────────────────────────────────────────

function sanitize(html: unknown): string {
  return DOMPurify.sanitize(String(html ?? ''), { USE_PROFILES: { html: true, svg: true } }) as unknown as string;
}

function Html(props: WidgetProps) {
  return (
    <Described model={props.model} class="w-html">
      <div class="w-html-content" innerHTML={sanitize(props.model.state.value)} />
    </Described>
  );
}

function Label(props: WidgetProps) {
  return (
    <div class="w-label" style={layoutStyle(props.model)}>
      {String(props.model.state.value ?? '')}
    </div>
  );
}

function Progress(props: WidgetProps) {
  const state = props.model.state;
  const fraction = () => {
    const min = Number(state.min ?? 0);
    const max = Number(state.max ?? 100);
    const value = Number(state.value ?? 0);
    return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  };
  const color = () => styleModel(props.model).bar_color as string | undefined;
  return (
    <Described model={props.model} class="w-progress-control">
      <div class="w-progress" data-style={state.bar_style || undefined} classList={{ vertical: state.orientation === 'vertical' }}>
        <div class="w-progress-bar" style={{ width: `${fraction() * 100}%`, background: color() || undefined }} />
      </div>
    </Described>
  );
}

function OutputWidget(props: WidgetProps) {
  return (
    <div class="w-output" style={layoutStyle(props.model)}>
      <For each={(props.model.state.outputs as Output[]) ?? []}>{(output) => <OutputView output={output} />}</For>
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

function formatNumber(value: number, format: string | undefined, integer: boolean): string {
  if (integer) return String(Math.round(value));
  const fixed = /^\.(\d+)f$/.exec(format ?? '.2f');
  return fixed ? value.toFixed(Number(fixed[1])) : String(Number(value.toPrecision(6)));
}

function Slider(props: WidgetProps) {
  const state = props.model.state;
  const integer = () => String(state._model_name).startsWith('Int');
  const read = (input: HTMLInputElement) => (integer() ? Math.round(Number(input.value)) : Number(input.value));
  const fraction = () => {
    const min = Number(state.min ?? 0);
    const max = Number(state.max ?? 100);
    return max > min ? ((Number(state.value ?? min) - min) / (max - min)) * 100 : 0;
  };
  return (
    <Described model={props.model}>
      <input
        class="w-slider"
        type="range"
        min={state.min}
        max={state.max}
        step={state.step ?? (integer() ? 1 : 0.1)}
        value={state.value}
        disabled={state.disabled}
        style={{ '--fill': `${fraction()}%` }}
        onInput={(event) => {
          const value = read(event.currentTarget);
          // Without continuous updates the kernel hears only about the final value.
          if (state.continuous_update === false) props.model.set({ value });
          else updateWidget(props.model, { value });
        }}
        onChange={(event) => updateWidget(props.model, { value: read(event.currentTarget) })}
      />
      <Show when={state.readout !== false}>
        <output class="w-readout">{formatNumber(Number(state.value ?? 0), state.readout_format, integer())}</output>
      </Show>
    </Described>
  );
}

function NumberInput(props: WidgetProps) {
  const state = props.model.state;
  const integer = () => /Int/.test(String(state._model_name));
  return (
    <Described model={props.model}>
      <input
        class="w-input"
        type="number"
        min={state.min ?? undefined}
        max={state.max ?? undefined}
        step={state.step ?? (integer() ? 1 : 'any')}
        value={state.value}
        disabled={state.disabled}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isFinite(value)) updateWidget(props.model, { value: integer() ? Math.round(value) : value });
        }}
      />
    </Described>
  );
}

function TextInput(props: WidgetProps) {
  const state = props.model.state;
  const name = () => String(state._model_name);
  const commit = (value: string, final: boolean) => {
    if (final || state.continuous_update !== false) updateWidget(props.model, { value });
    else props.model.set({ value });
  };
  return (
    <Described model={props.model}>
      <Show
        when={name() === 'TextareaModel'}
        fallback={
          <input
            class="w-input w-text"
            type={name() === 'PasswordModel' ? 'password' : 'text'}
            value={state.value ?? ''}
            placeholder={state.placeholder ?? ''}
            disabled={state.disabled}
            spellcheck={false}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') sendWidgetEvent(props.model, { event: 'submit' });
            }}
            onInput={(event) => commit(event.currentTarget.value, false)}
            onChange={(event) => commit(event.currentTarget.value, true)}
          />
        }
      >
        <textarea
          class="w-input w-textarea"
          rows={state.rows ?? 3}
          value={state.value ?? ''}
          placeholder={state.placeholder ?? ''}
          disabled={state.disabled}
          spellcheck={false}
          onKeyDown={(event) => event.stopPropagation()}
          onInput={(event) => commit(event.currentTarget.value, false)}
          onChange={(event) => commit(event.currentTarget.value, true)}
        />
      </Show>
    </Described>
  );
}

function Checkbox(props: WidgetProps) {
  const state = props.model.state;
  return (
    <div class="w-control w-checkbox" style={layoutStyle(props.model)}>
      <Show when={state.indent !== false}>
        <span class="w-description" />
      </Show>
      <label>
        <input
          type="checkbox"
          checked={!!state.value}
          disabled={state.disabled}
          onChange={(event) => updateWidget(props.model, { value: event.currentTarget.checked })}
        />
        {state.description}
      </label>
    </div>
  );
}

function ToggleButton(props: WidgetProps) {
  const state = props.model.state;
  return (
    <button
      class="w-button"
      classList={{ pressed: !!state.value }}
      data-style={state.button_style || undefined}
      disabled={state.disabled}
      title={state.tooltip ?? undefined}
      style={layoutStyle(props.model)}
      onClick={() => updateWidget(props.model, { value: !state.value })}
    >
      {state.description}
    </button>
  );
}

function Button(props: WidgetProps) {
  const state = props.model.state;
  return (
    <button
      class="w-button"
      data-style={state.button_style || undefined}
      disabled={state.disabled}
      title={state.tooltip ?? undefined}
      style={layoutStyle(props.model)}
      onClick={() => sendWidgetEvent(props.model, { event: 'click' })}
    >
      {state.description}
    </button>
  );
}

function Dropdown(props: WidgetProps) {
  const state = props.model.state;
  const labels = () => (state._options_labels as string[]) ?? [];
  const list = () => state._model_name === 'SelectModel';
  return (
    <Described model={props.model}>
      <select
        class="w-select"
        size={list() ? Math.min(Math.max(labels().length, 2), state.rows ?? 5) : undefined}
        disabled={state.disabled}
        onChange={(event) => updateWidget(props.model, { index: event.currentTarget.selectedIndex })}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <For each={labels()}>{(label, i) => <option selected={state.index === i()}>{label}</option>}</For>
      </select>
    </Described>
  );
}

function Choices(props: WidgetProps) {
  const state = props.model.state;
  const labels = () => (state._options_labels as string[]) ?? [];
  const radio = () => state._model_name === 'RadioButtonsModel';
  return (
    <Described model={props.model} class={radio() ? 'w-radios' : 'w-segments'}>
      <Show
        when={radio()}
        fallback={
          <div class="w-segmented">
            <For each={labels()}>
              {(label, i) => (
                <button classList={{ active: state.index === i() }} disabled={state.disabled} onClick={() => updateWidget(props.model, { index: i() })}>
                  {label}
                </button>
              )}
            </For>
          </div>
        }
      >
        <div class="w-radio-list">
          <For each={labels()}>
            {(label, i) => (
              <label>
                <input
                  type="radio"
                  name={props.model.id}
                  checked={state.index === i()}
                  disabled={state.disabled}
                  onChange={() => updateWidget(props.model, { index: i() })}
                />
                {label}
              </label>
            )}
          </For>
        </div>
      </Show>
    </Described>
  );
}

function ColorPicker(props: WidgetProps) {
  const state = props.model.state;
  return (
    <Described model={props.model}>
      <input class="w-color" type="color" value={state.value ?? '#000000'} disabled={state.disabled} onInput={(event) => updateWidget(props.model, { value: event.currentTarget.value })} />
      <Show when={!state.concise}>
        <span class="w-readout">{state.value}</span>
      </Show>
    </Described>
  );
}

function Unsupported(props: WidgetProps) {
  return <div class="w-unsupported">{String(props.model.state._model_name ?? 'This widget').replace(/Model$/, '')} is not supported yet</div>;
}

const VIEWS: Record<string, (props: WidgetProps) => JSX.Element> = {
  HBoxModel: Box,
  VBoxModel: Box,
  BoxModel: Box,
  GridBoxModel: Box,
  TabModel: Tabs,
  AccordionModel: Accordion,
  HTMLModel: Html,
  HTMLMathModel: Html,
  LabelModel: Label,
  IntProgressModel: Progress,
  FloatProgressModel: Progress,
  OutputModel: OutputWidget,
  IntSliderModel: Slider,
  FloatSliderModel: Slider,
  IntTextModel: NumberInput,
  FloatTextModel: NumberInput,
  BoundedIntTextModel: NumberInput,
  BoundedFloatTextModel: NumberInput,
  TextModel: TextInput,
  TextareaModel: TextInput,
  PasswordModel: TextInput,
  CheckboxModel: Checkbox,
  ToggleButtonModel: ToggleButton,
  ButtonModel: Button,
  DropdownModel: Dropdown,
  SelectModel: Dropdown,
  RadioButtonsModel: Choices,
  ToggleButtonsModel: Choices,
  ColorPickerModel: ColorPicker,
};

export function WidgetNode(props: { id: string }) {
  const model = createMemo(() => widgetModel(props.id));
  return (
    <Show when={model()} keyed>
      {(found) => <Dynamic component={VIEWS[found.state._model_name as string] ?? Unsupported} model={found} />}
    </Show>
  );
}

function WidgetView(props: { data: unknown }) {
  const id = () => (props.data as { model_id?: string } | null)?.model_id ?? '';
  return (
    <div class="widget-root">
      <WidgetNode id={id()} />
    </div>
  );
}

// A widget view is only useful while its model is alive in the kernel; a notebook reopened
// later falls back to the next representation (plain text).
registerRenderer('application/vnd.jupyter.widget-view+json', WidgetView, {
  first: true,
  accepts: (data) => !!widgetModel((data as { model_id?: string } | null)?.model_id),
});

