// A panel's icon can't be changed after creation, so pick the variant for the
// current DevTools theme (it updates the next time the toolbox opens).
const icon = browser.devtools.panels.themeName === 'dark' ? '/icon-dark.svg' : '/icon-light.svg';
browser.devtools.panels.create('Source Tree', icon, '/panel.html');
