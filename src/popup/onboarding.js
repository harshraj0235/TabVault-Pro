function nextStep(step) {
  // Hide all
  document.querySelectorAll('.step-card').forEach(card => card.classList.remove('active'));
  document.querySelectorAll('.dot').forEach(dot => dot.classList.remove('active'));
  
  // Show target
  const target = document.getElementById(`step${step}`);
  if (target) {
    // Small delay to allow CSS transition to reset if needed
    setTimeout(() => {
      target.classList.add('active');
    }, 50);
  }
  
  const dot = document.getElementById(`dot${step}`);
  if (dot) dot.classList.add('active');
}

function finish() {
  window.close();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnNext1').addEventListener('click', () => nextStep(2));
  document.getElementById('btnNext2').addEventListener('click', () => nextStep(3));
  document.getElementById('btnNext3').addEventListener('click', () => nextStep(4));
  document.getElementById('btnFinish').addEventListener('click', finish);
});

// Simple blinking cursor animation for step 2
const style = document.createElement('style');
style.innerHTML = `
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
`;
document.head.appendChild(style);
