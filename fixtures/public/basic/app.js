const message = document.querySelector('#message');
const button = document.querySelector('#action-button');

if (message) {
  message.textContent = 'JavaScript executed successfully.';
}

button?.addEventListener('click', () => {
  if (message) {
    message.textContent = 'Interaction completed.';
  }
});
