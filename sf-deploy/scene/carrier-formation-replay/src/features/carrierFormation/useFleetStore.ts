import { create } from "zustand";
import { carrierFormation } from "./data/mockFormation";

interface FleetState {
  dayIndex: number;
  selectedEventId: string;
  isPlaying: boolean;
  setDayIndex: (dayIndex: number) => void;
  nextDay: () => void;
  previousDay: () => void;
  togglePlaying: () => void;
  setPlaying: (isPlaying: boolean) => void;
  selectEvent: (eventId: string) => void;
}

const maxDayIndex = carrierFormation.track.length - 1;

function clampDay(dayIndex: number) {
  return Math.min(maxDayIndex, Math.max(0, dayIndex));
}

function primaryEventIdForDay(dayIndex: number) {
  const exactEvent = carrierFormation.events.find((event) => event.dayIndex === dayIndex);
  if (exactEvent) {
    return exactEvent.id;
  }

  const previousEvent = carrierFormation.events
    .filter((event) => event.dayIndex <= dayIndex)
    .at(-1);

  return previousEvent?.id ?? carrierFormation.events[0].id;
}

export const useFleetStore = create<FleetState>((set) => ({
  dayIndex: 0,
  selectedEventId: carrierFormation.events[0].id,
  isPlaying: false,
  setDayIndex: (dayIndex) => {
    const nextIndex = clampDay(dayIndex);
    set({
      dayIndex: nextIndex,
      selectedEventId: primaryEventIdForDay(nextIndex),
    });
  },
  nextDay: () =>
    set((state) => {
      const nextIndex = clampDay(state.dayIndex + 1);
      return {
        dayIndex: nextIndex,
        selectedEventId: primaryEventIdForDay(nextIndex),
        isPlaying: nextIndex < maxDayIndex ? state.isPlaying : false,
      };
    }),
  previousDay: () =>
    set((state) => {
      const nextIndex = clampDay(state.dayIndex - 1);
      return {
        dayIndex: nextIndex,
        selectedEventId: primaryEventIdForDay(nextIndex),
      };
    }),
  togglePlaying: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setPlaying: (isPlaying) => set({ isPlaying }),
  selectEvent: (eventId) => {
    const event = carrierFormation.events.find((item) => item.id === eventId);
    if (!event) {
      return;
    }

    set({
      dayIndex: event.dayIndex,
      selectedEventId: event.id,
      isPlaying: false,
    });
  },
}));

export function getCurrentTrackPoint(dayIndex: number) {
  return carrierFormation.track[clampDay(dayIndex)];
}

export function getSelectedEvent(selectedEventId: string, dayIndex: number) {
  const selected = carrierFormation.events.find((event) => event.id === selectedEventId);
  if (selected) {
    return selected;
  }

  return carrierFormation.events.find((event) => event.dayIndex === dayIndex);
}

