export function Avatar(props: { name: string; color?: string; size?: number }) {
  const initials = () => {
    const name = props.name.trim();
    if (!name) return "?";
    const ascii = name.match(/[A-Za-z]/g);
    if (ascii && ascii.length >= 2) return (ascii[0]! + ascii[1]!).toUpperCase();
    return name.slice(0, 2);
  };
  const size = () => props.size ?? 30;
  return (
    <div
      class="avatar"
      title={props.name}
      style={{
        background: props.color ?? "#7dd3fc",
        width: `${size()}px`,
        height: `${size()}px`,
      }}
    >
      {initials()}
    </div>
  );
}
