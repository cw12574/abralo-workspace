import { forwardRef, useImperativeHandle, useRef } from 'react';
import { EmployeeMark } from './employee-mark';
import type { VoiceLevels } from './voice-meter';
import type { VoiceState } from './briefing-voice';
export type PresenceHandle = { update: (levels: VoiceLevels) => void };

export const ChiefPresence = forwardRef<
  PresenceHandle,
  { state: VoiceState; muted: boolean; busy: boolean; employeeId?: string }
>(function ChiefPresence({ state, muted, busy, employeeId = 'chief' }, ref) {
  const portrait = useRef<HTMLDivElement>(null);
  const bars = useRef<SVGGElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      update({ input, output }) {
        portrait.current?.style.setProperty('--voice-energy', String(output));
        Array.from(bars.current?.children || []).forEach((bar, i) => {
          const height = 3 + (input[i] || 0) * 38 * Math.sin((Math.PI * (i + 1)) / 25);
          bar.setAttribute('y', String((48 - height) / 2));
          bar.setAttribute('height', String(height));
        });
      },
    }),
    [],
  );
  return (
    <div
      className={`chief-presence ${state}${busy ? ' thinking' : ''}${muted ? ' muted' : ''}`}
      aria-hidden="true"
    >
      <div className="chief-portrait" ref={portrait}>
        <div className="chief-halo" />
        <EmployeeMark id={employeeId} className="chief-illustration" />
      </div>
      <svg className="chief-wave" viewBox="0 0 192 48">
        <g ref={bars} fill="currentColor">
          {Array.from({ length: 24 }, (_, i) => (
            <rect key={i} x={i * 8 + 2} y="22.5" width="3" height="3" rx="0.5" />
          ))}
        </g>
      </svg>
    </div>
  );
});
