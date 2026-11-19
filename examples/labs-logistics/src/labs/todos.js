export function filterTodos(todos, filter) {
  if (filter === "active") return todos.filter((todo) => !todo.completed);
  if (filter === "completed") return todos.filter((todo) => todo.completed);
  return todos;
}

export function toggleTodo(todos, id) {
  return todos.map((todo) => (
    todo.id === id ? { ...todo, completed: !todo.completed } : todo
  ));
}

export function syncTodoTitle(documentRef, count) {
  const previousTitle = documentRef.title;
  documentRef.title = `할 일 ${count}개 · Mini React`;
  return () => {
    documentRef.title = previousTitle;
  };
}
