// Stand-in for SADX's window in the video tests: 1280x960, redrawn every 16 ms so the capture always has frames.
// test/video-recovery.mjs compiles it with the C# compiler that comes with Windows (.NET Framework 4).
using System.Drawing;
using System.Windows.Forms;

class FakeGame : Form
{
    int tick;

    FakeGame()
    {
        Text = "SADX Online test window";
        ClientSize = new Size(1280, 960);
        DoubleBuffered = true;
        var timer = new Timer { Interval = 16 };
        timer.Tick += (s, e) => { tick++; Invalidate(); };
        timer.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Color.FromArgb(20, 20, 40));
        e.Graphics.FillRectangle(Brushes.Orange, (tick * 7) % ClientSize.Width, 400, 120, 120);
    }

    [System.STAThread]
    static void Main() { Application.Run(new FakeGame()); }
}
