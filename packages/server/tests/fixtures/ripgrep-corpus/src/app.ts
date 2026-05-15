import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("world");
  return { count, name, setCount, setName };
}
