import { useState, useEffect } from "react";

export function Deep() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(true);
  }, []);
  return open;
}
