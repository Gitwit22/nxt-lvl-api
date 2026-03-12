import { timelineEvents } from "@/data/documents";

const Timeline = () => {
  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-6 top-0 bottom-0 w-px bg-border" />

      <div className="space-y-8">
        {timelineEvents.map((event, i) => (
          <div key={event.year} className="relative flex items-start gap-6 group">
            {/* Dot */}
            <div className="relative z-10 flex-shrink-0 w-12 flex justify-center">
              <div className="w-3 h-3 rounded-full bg-primary border-2 border-card shadow-sm group-hover:scale-125 transition-transform" />
            </div>

            {/* Content */}
            <div className="pb-2 -mt-1">
              <span className="text-sm font-body font-semibold text-primary">{event.year}</span>
              <h3 className="font-display text-lg font-semibold text-foreground mt-0.5">{event.title}</h3>
              <p className="text-sm text-muted-foreground font-body mt-1 leading-relaxed max-w-lg">
                {event.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Timeline;
