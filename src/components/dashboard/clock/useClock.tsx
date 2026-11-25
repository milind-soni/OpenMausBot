import { useEffect, useState } from "react";

export const useClock = () => {
  const [currentDate, setCurrentDate] = useState("");
  const [currentTime, setCurrentTime] = useState("");

  useEffect(() => {
    const updateDateTime = () => {
      const now = new Date();

      // Format time as HH:MM (e.g., 12:20)
      setCurrentTime(
        now.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );

      // Format date as Month Day (e.g., November 7)
      setCurrentDate(
        now.toLocaleDateString("en-US", { month: "long", day: "numeric" }),
      );
    };

    updateDateTime(); // Set immediately on mount
    const timer = setInterval(updateDateTime, 1000);

    return () => clearInterval(timer);
  }, []);

  return { currentDate, currentTime };
};
