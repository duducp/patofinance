document.addEventListener('DOMContentLoaded', () => {
  // Fade-in on scroll
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });
  document.querySelectorAll('.fade-in').forEach((el) => observer.observe(el));

  // Show more commands toggle
  const btn = document.getElementById('show-more-cmds');
  const wrapper = document.querySelector('.commands-grid-wrapper');
  if (btn && wrapper) {
    btn.addEventListener('click', () => {
      const expanded = wrapper.classList.toggle('expanded');
      btn.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', expanded);
      btn.querySelector('.show-more-text').textContent = expanded
        ? 'Ver menos comandos'
        : 'Ver mais comandos';

      // Stagger reveal hidden cards
      const hiddenCards = wrapper.querySelectorAll('.command-card:nth-child(n+9)');
      hiddenCards.forEach((card, i) => {
        card.style.transitionDelay = expanded ? `${i * 0.04}s` : '0s';
      });

      if (!expanded) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  }
});
