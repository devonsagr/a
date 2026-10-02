// Keep the upstream exploration workspace available alongside the project workflow.
if (window.location.pathname.startsWith('/explore')) {
  void import('./legacy-main');
} else {
  void import('./project-canvas/main');
}
