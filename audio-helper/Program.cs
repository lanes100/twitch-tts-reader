using System;
using System.IO;
using System.Text;
using NAudio.Wave;

class Player : IDisposable
{
    private IWavePlayer? output;
    private AudioFileReader? reader;
    private float volume = 1.0f;

    public void Play(string path, Action? onStopped)
    {
        Stop();
        reader = new AudioFileReader(path);
        reader.Volume = volume;
        output = new WaveOutEvent();
        output.Init(reader);
        if (onStopped != null)
        {
            output.PlaybackStopped += (s, e) => { onStopped(); };
        }
        output.Play();
    }

    public void Pause()
    {
        if (output != null) output.Pause();
    }

    public void Resume()
    {
        if (output != null) output.Play();
    }

    public void Stop()
    {
        if (output != null)
        {
            output.Stop();
            output.Dispose();
            output = null;
        }
        if (reader != null)
        {
            reader.Dispose();
            reader = null;
        }
    }

    public void SetVolume(float v)
    {
        volume = Math.Clamp(v, 0f, 1f);
        if (reader != null) reader.Volume = volume;
    }

    public bool IsStopped()
    {
        return output == null || output.PlaybackState == PlaybackState.Stopped;
    }

    public void Dispose() { Stop(); }
}

class Program
{
    static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        using var player = new Player();
        var lastPlayed = false;
        while (true)
        {
            var line = Console.ReadLine();
            if (string.IsNullOrWhiteSpace(line)) { System.Threading.Thread.Sleep(10); continue; }
            if (line.StartsWith("PLAY ", StringComparison.OrdinalIgnoreCase))
            {
                var path = line.Substring(5).Trim();
                if (File.Exists(path))
                {
                    player.Play(path, () => { Console.WriteLine("DONE"); lastPlayed = false; });
                    lastPlayed = true;
                    Console.WriteLine("ACK");
                }
                else Console.WriteLine("ERR:NOT_FOUND");
            }
            else if (line.StartsWith("PAUSE", StringComparison.OrdinalIgnoreCase))
            {
                player.Pause();
                Console.WriteLine("ACK");
            }
            else if (line.StartsWith("RESUME", StringComparison.OrdinalIgnoreCase))
            {
                player.Resume();
                Console.WriteLine("ACK");
            }
            else if (line.StartsWith("STOP", StringComparison.OrdinalIgnoreCase))
            {
                player.Stop();
                lastPlayed = false;
                Console.WriteLine("STOPPED");
            }
            else if (line.StartsWith("VOLUME ", StringComparison.OrdinalIgnoreCase))
            {
                if (float.TryParse(line.Substring(7).Trim(), out var v))
                {
                    player.SetVolume(v);
                    Console.WriteLine("ACK");
                }
                else Console.WriteLine("ERR:BAD_VOLUME");
            }
            else
            {
                Console.WriteLine("ACK");
            }
        }
    }
}
