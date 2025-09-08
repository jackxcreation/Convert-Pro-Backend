# Secure Download API for Convert Pro

```javascript
// app/api/download/[token]/route.js

import { NextRequest, NextResponse } from 'next/server';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';

/**
 * GET /api/download/[token]
 * Secure file download using temporary tokens
 */
export async function GET(request, { params }) {
  try {
    const { token } = params;
    
    if (!token) {
      return NextResponse.json(
        { error: 'Download token required' },
        { status: 400 }
      );
    }
    
    const supabase = createClientComponentClient();
    
    // Verify download token
    const { data: downloadToken, error: tokenError } = await supabase
      .from('download_tokens')
      .select(`
        *,
        file_uploads (
          original_name,
          output_format,
          user_id,
          status
        )
      `)
      .eq('token', token)
      .single();
      
    if (tokenError || !downloadToken) {
      return NextResponse.json(
        { error: 'Invalid or expired download token' },
        { status: 404 }
      );
    }
    
    // Check if token is expired
    const now = new Date();
    const expiresAt = new Date(downloadToken.expires_at);
    
    if (now > expiresAt) {
      // Clean up expired token
      await supabase
        .from('download_tokens')
        .delete()
        .eq('token', token);
        
      return NextResponse.json(
        { error: 'Download token has expired' },
        { status: 410 }
      );
    }
    
    // Check download limits
    if (downloadToken.downloads >= downloadToken.max_downloads) {
      return NextResponse.json(
        { error: 'Download limit exceeded' },
        { status: 429 }
      );
    }
    
    // Check if file exists
    const filePath = downloadToken.file_path;
    
    try {
      await fs.access(filePath);
    } catch {
      // File doesn't exist, clean up token
      await supabase
        .from('download_tokens')
        .delete()
        .eq('token', token);
        
      return NextResponse.json(
        { error: 'File no longer available' },
        { status: 404 }
      );
    }
    
    // Get file stats
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    
    // Determine filename for download
    const originalName = downloadToken.file_uploads?.original_name || 'converted_file';
    const outputFormat = downloadToken.file_uploads?.output_format || 'bin';
    const downloadFilename = generateDownloadFilename(originalName, outputFormat);
    
    // Update download count
    await supabase
      .from('download_tokens')
      .update({ 
        downloads: downloadToken.downloads + 1,
        last_downloaded_at: new Date().toISOString()
      })
      .eq('token', token);
    
    // Handle range requests for large files
    const range = request.headers.get('range');
    
    if (range) {
      return handleRangeRequest(filePath, range, fileSize, downloadFilename);
    }
    
    // Read file and stream response
    const fileBuffer = await fs.readFile(filePath);
    
    // Set appropriate headers
    const headers = new Headers({
      'Content-Type': getMimeType(outputFormat),
      'Content-Length': fileSize.toString(),
      'Content-Disposition': `attachment; filename="${downloadFilename}"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    return new NextResponse(fileBuffer, {
      status: 200,
      headers
    });
    
  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Download failed' },
      { status: 500 }
    );
  }
}

/**
 * Handle range requests for large file downloads
 */
async function handleRangeRequest(filePath, rangeHeader, fileSize, filename) {
  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = (end - start) + 1;
  
  // Read file chunk
  const fileHandle = await fs.open(filePath, 'r');
  const buffer = Buffer.alloc(chunkSize);
  
  await fileHandle.read(buffer, 0, chunkSize, start);
  await fileHandle.close();
  
  const headers = new Headers({
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize.toString(),
    'Content-Type': getMimeType(path.extname(filePath).slice(1)),
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  
  return new NextResponse(buffer, {
    status: 206, // Partial Content
    headers
  });
}

/**
 * Generate appropriate download filename
 */
function generateDownloadFilename(originalName, outputFormat) {
  // Remove original extension
  const baseName = originalName.replace(/\.[^/.]+$/, "");
  
  // Clean filename (remove special characters)
  const cleanBaseName = baseName.replace(/[^\w\s-]/g, '').trim();
  
  return `${cleanBaseName}.${outputFormat}`;
}

/**
 * Get MIME type for file format
 */
function getMimeType(format) {
  const mimeTypes = {
    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    
    // Videos
    'mp4': 'video/mp4',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'flv': 'video/x-flv',
    '3gp': 'video/3gpp',
    
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'ogg': 'audio/ogg',
    'wma': 'audio/x-ms-wma',
    
    // Documents
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'doc': 'application/msword',
    'txt': 'text/plain',
    'rtf': 'application/rtf',
    'odt': 'application/vnd.oasis.opendocument.text',
    
    // Archives
    'zip': 'application/zip',
    'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    'tar': 'application/x-tar',
    'gz': 'application/gzip'
  };
  
  return mimeTypes[format.toLowerCase()] || 'application/octet-stream';
}

/**
 * POST /api/download/[token] - Update download preferences
 */
export async function POST(request, { params }) {
  try {
    const { token } = params;
    const { filename } = await request.json();
    
    if (!token) {
      return NextResponse.json(
        { error: 'Download token required' },
        { status: 400 }
      );
    }
    
    const supabase = createClientComponentClient();
    
    // Update token with custom filename
    const { error } = await supabase
      .from('download_tokens')
      .update({ custom_filename: filename })
      .eq('token', token);
    
    if (error) {
      return NextResponse.json(
        { error: 'Failed to update download preferences' },
        { status: 500 }
      );
    }
    
    return NextResponse.json({ success: true });
    
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update preferences' },
      { status: 500 }
    );
  }
}
```

## Download Token Management API:

```javascript
// app/api/download/cleanup/route.js

import { NextResponse } from 'next/server';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import fs from 'fs/promises';

/**
 * POST /api/download/cleanup
 * Clean up expired tokens and files (cron job endpoint)
 */
export async function POST(request) {
  try {
    // Verify cron authorization
    const authHeader = request.headers.get('authorization');
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
    
    if (authHeader !== expectedAuth) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    const supabase = createClientComponentClient();
    
    // Get expired tokens
    const { data: expiredTokens, error } = await supabase
      .from('download_tokens')
      .select('file_path')
      .lt('expires_at', new Date().toISOString());
    
    if (error) {
      throw error;
    }
    
    let deletedFiles = 0;
    let deletedTokens = 0;
    
    if (expiredTokens && expiredTokens.length > 0) {
      // Delete expired files
      for (const tokenData of expiredTokens) {
        try {
          await fs.unlink(tokenData.file_path);
          deletedFiles++;
        } catch (fileError) {
          console.error('Failed to delete file:', tokenData.file_path, fileError);
        }
      }
      
      // Delete expired tokens from database
      const { error: deleteError } = await supabase
        .from('download_tokens')
        .delete()
        .lt('expires_at', new Date().toISOString());
      
      if (!deleteError) {
        deletedTokens = expiredTokens.length;
      }
    }
    
    // Also clean up old upload files (older than 24 hours)
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    
    const { data: oldUploads } = await supabase
      .from('file_uploads')
      .select('temp_path, output_path')
      .lt('uploaded_at', oneDayAgo.toISOString())
      .in('status', ['completed', 'failed']);
    
    let deletedUploads = 0;
    
    if (oldUploads) {
      for (const upload of oldUploads) {
        try {
          // Delete temp file
          if (upload.temp_path) {
            await fs.unlink(upload.temp_path);
          }
          // Delete output file
          if (upload.output_path) {
            await fs.unlink(upload.output_path);
          }
          deletedUploads++;
        } catch (fileError) {
          console.error('Failed to delete old upload:', fileError);
        }
      }
      
      // Update database records
      await supabase
        .from('file_uploads')
        .update({ 
          temp_path: null,
          output_path: null,
          status: 'cleaned'
        })
        .lt('uploaded_at', oneDayAgo.toISOString())
        .in('status', ['completed', 'failed']);
    }
    
    return NextResponse.json({
      success: true,
      cleanup_stats: {
        expired_tokens_deleted: deletedTokens,
        expired_files_deleted: deletedFiles,
        old_uploads_cleaned: deletedUploads
      }
    });
    
  } catch (error) {
    console.error('Cleanup error:', error);
    return NextResponse.json(
      { error: 'Cleanup failed' },
      { status: 500 }
    );
  }
}
```

## Environment Variables (add to .env.local):

```bash
# Add to your .env.local
CRON_SECRET=your-secure-cron-secret-key-here
```

## Frontend Download Component:

```jsx
// components/DownloadButton.jsx

"use client";

import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';

const DownloadButton = ({ downloadUrl, filename, fileInfo }) => {
  const [downloading, setDownloading] = useState(false);
  
  const handleDownload = async () => {
    setDownloading(true);
    
    try {
      // Trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Track download analytics
      if (typeof gtag !== 'undefined') {
        gtag('event', 'file_download', {
          file_type: fileInfo?.outputFormat,
          file_size: fileInfo?.outputSize
        });
      }
      
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setDownloading(false);
    }
  };
  
  return (
    <motion.button
      onClick={handleDownload}
      disabled={downloading}
      className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
    >
      <Download className="h-4 w-4" />
      {downloading ? 'Downloading...' : 'Download'}
    </motion.button>
  );
};

export default DownloadButton;
```

This download system provides:
- âœ… **Secure Downloads** (Token-based access control)
- âœ… **Range Requests** (Support for large file streaming)
- âœ… **Download Limits** (Configurable download limits per token)
- âœ… **Automatic Cleanup** (Scheduled cleanup of expired files)
- âœ… **Custom Filenames** (User-friendly download filenames)
- âœ… **MIME Type Detection** (Proper content-type headers)
- âœ… **Error Handling** (Comprehensive error management)
