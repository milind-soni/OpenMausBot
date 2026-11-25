"use client";
import { useClock } from "./useClock";

export const DateTimeDisplay = () => {
  const { currentDate, currentTime } = useClock();

  return (
    <div className="flex flex-col items-end text-ink">
      <div className="whitespace-nowrap text-6xl font-light tracking-wide sm:text-7xl xl:text-8xl">
        {currentTime}
      </div>
      <div className="text-xl font-normal xl:text-2xl">{currentDate}</div>
    </div>
  );
};
